"""Semantic index of the vault, stored on disk with LanceDB.

Embeddings are computed in the browser (a small local model), so this module only
chunks notes and documents (PDF, Word, PowerPoint, Excel, emails, text – see documents.py),
tracks which ones are stale, stores vectors and answers nearest-neighbour queries.
If LanceDB isn't installed, `available` is False and the app falls back to keyword search.
"""
import atexit
import json
import os
import re
import shutil
import threading
import time
from datetime import timedelta
from pathlib import Path

from . import documents, fsutil

try:
    import lancedb
    import pyarrow as pa
    available = True
except ImportError:  # optional dependency
    lancedb = pa = None
    available = False

DIM = 384  # all-MiniLM-L6-v2

# Files the browser needs to embed notes. Served from ./models (made by offline_bundle.py for
# computers without internet), else downloaded once into data/models.
EMBED_SOURCES = {"hf": "https://huggingface.co/", "cdn": "https://cdn.jsdelivr.net/"}
_MODEL = "Xenova/all-MiniLM-L6-v2/resolve/main/"
_RUNTIME = "npm/@huggingface/transformers@3.0.2/dist/"
EMBED_FILES = {
    # model_quantized.onnx runs on the CPU; model.onnx (full precision) runs on the GPU through WebGPU
    "hf": [_MODEL + f for f in ("config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx", "onnx/model.onnx")],
    "cdn": [_RUNTIME + f for f in ("transformers.min.js", "ort-wasm-simd-threaded.jsep.wasm")],
}
TABLE = "chunks"
FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
MAX_CHARS, OVERLAP, MAX_CHUNKS = 800, 120, 200
DOC_MAX_CHUNKS = 2500   # documents can be long: a 600-page PDF is ~2,000 chunks
BATCH_CHUNKS = 300      # roughly how many chunks one /api/index/next hands to the browser
SAVE_EVERY = 2.0        # seconds between writes of index_state.json


def vault_notes(root):
    """{relative path: mtime_ns} for every visible .md note in the vault (from the shared, cached scan)."""
    return dict(documents.scan(root)["notes"])


def vault_files(root, docs=False):
    """Notes, plus documents when `docs` is on: {relative path: mtime_ns}."""
    sc = documents.scan(root)
    out = dict(sc["notes"])
    if docs:
        out.update(sc["docs"])
    return out


def chunk_markdown(text, title):
    """Split a note into heading-aware chunks of at most ~800 characters."""
    text = re.sub(r"%%.*?%%", "", text, flags=re.S)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    sections, heading, buf, fence = [], "", [], False
    for line in text.splitlines():
        if FENCE.match(line):
            fence = not fence
        m = None if fence else HEADING.match(line)
        if m:
            sections.append((heading, "\n".join(buf)))
            heading, buf = m.group(2).strip(), []
        else:
            buf.append(line)
    sections.append((heading, "\n".join(buf)))
    return _chunk(sections, title, MAX_CHUNKS)


def chunk_document(sections, title):
    """Chunks for a document: each section (page, slide, sheet, email…) is chunked on its own."""
    return _chunk([(s.get("heading", ""), s.get("text", "")) for s in sections], title, DOC_MAX_CHUNKS)


def _chunk(sections, title, max_chunks):
    chunks = []
    for head, body in sections:
        paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
        cur = ""
        for para in paras:
            while len(para) > MAX_CHARS:  # very long paragraph: hard split with overlap
                if cur:
                    chunks.append((head, cur))
                    cur = ""
                cut = para.rfind(" ", 0, MAX_CHARS)
                cut = cut if cut > MAX_CHARS // 2 else MAX_CHARS
                chunks.append((head, para[:cut]))
                para = para[max(cut - OVERLAP, 1):]
            if cur and len(cur) + len(para) + 2 > MAX_CHARS:
                chunks.append((head, cur))
                cur = cur[-OVERLAP:].split(" ", 1)[-1] + "\n\n" + para if len(cur) > OVERLAP else para
            else:
                cur = f"{cur}\n\n{para}" if cur else para
        if cur:
            chunks.append((head, cur))
    if not chunks:
        chunks = [("", "")]  # empty note: still findable by title
    out = []
    for head, body in chunks[:max_chunks]:
        label = f"{title} › {head}" if head else title
        out.append({"heading": head, "text": body, "embed": f"{label}\n{body}".strip()})
    return out


class VectorIndex:
    def __init__(self, base_dir):
        self.dir = Path(base_dir)
        self.texts = documents.TextCache(self.dir / "docs")  # extracted document text
        self.state_path = self.dir / "index_state.json"
        self.lock = threading.RLock()
        self._db = None
        self._writes = 0
        self._st, self._dirty, self._saved = None, False, 0.0
        atexit.register(self.flush)

    # ---------- state: kept in memory, written to disk at most every SAVE_EVERY seconds ----------
    # (writing it after every file made Windows report "Access is denied" whenever OneDrive or an antivirus held it;
    # if Keystone stops before a save, the last few files are simply embedded again – their rows are replaced, never doubled)
    def _state(self):
        with self.lock:
            if self._st is None:
                # a file that is briefly locked must never look like "no index yet" – that would wipe and rebuild it
                self._st = fsutil.read_json(self.state_path, default={})
            return self._st

    def _save_state(self, st, force=False):
        with self.lock:
            self._st, self._dirty = st, True
            if force or time.monotonic() - self._saved >= SAVE_EVERY:
                self.flush()

    def flush(self):
        with self.lock:
            if not self._dirty or self._st is None:
                return
            try:
                fsutil.write_text(self.state_path, json.dumps(self._st))
                self._dirty, self._saved = False, time.monotonic()
            except OSError:
                pass  # still locked after the retries: kept in memory, saved with the next change

    def _db_conn(self):
        if self._db is None:
            self.dir.mkdir(parents=True, exist_ok=True)
            self._db = lancedb.connect(str(self.dir / "lancedb"))
        return self._db

    def _table(self, create=False):
        db = self._db_conn()
        try:
            return db.open_table(TABLE)
        except Exception:
            if not create:
                return None
            schema = pa.schema([pa.field("path", pa.string()), pa.field("chunk", pa.int32()), pa.field("heading", pa.string()),
                                pa.field("text", pa.string()), pa.field("vector", pa.list_(pa.float32(), DIM))])
            return db.create_table(TABLE, schema=schema)

    def _checked_state(self, root, model):
        """Load state; start over if the vault or embedding model changed."""
        st = self._state()
        if st.get("root") != str(root) or (model and st.get("model") and st.get("model") != model):
            self.reset()
            st = {"root": str(root), "model": model, "files": {}}
            self._save_state(st)
        st.setdefault("files", {})
        return st

    def reset(self):
        with self.lock:
            try:
                self._db_conn().drop_table(TABLE)
            except Exception:
                pass
            self._st, self._dirty = {}, False
            try:
                self.state_path.unlink()
            except OSError:
                pass
            shutil.rmtree(self.dir / "docs", ignore_errors=True)

    @staticmethod
    def _q(s):
        return s.replace("'", "''")

    # ---------- indexing ----------
    def _sync(self, root, model, docs=False):
        """Drop rows for deleted files; return (state, current files, stale paths – notes first, then newest first)."""
        st = self._checked_state(root, model)
        cur = vault_files(root, docs)
        gone = [p for p in st["files"] if p not in cur]
        if gone:
            tbl = self._table()
            for p in gone:
                if tbl is not None:
                    tbl.delete(f"path = '{self._q(p)}'")
                st["files"].pop(p, None)
            self._save_state(st)
            self.texts.prune(root, [p for p in cur if not p.endswith(".md")])
        stale = [p for p, m in cur.items() if st["files"].get(p, {}).get("mtime") != m]  # (files found not to be text keep a "skip" entry)
        stale.sort(key=lambda p: (not p.endswith(".md"), -cur[p]))  # notes are quick: do them first
        return st, cur, stale

    @staticmethod
    def _skipped(st, cur):
        return {p for p, f in st["files"].items() if f.get("skip") and p in cur and f.get("mtime") == cur[p]}

    def status(self, root, model, docs=False):
        with self.lock:
            st, cur, stale = self._sync(root, model, docs)
            skipped = self._skipped(st, cur)
            n_docs = sum(1 for p in cur if not p.endswith(".md") and p not in skipped)
            errors = {p: f["error"] for p, f in st["files"].items() if f.get("error") and p in cur}
            total = len(cur) - len(skipped)
            sc = documents.scan(root)
            return {"available": True, "total": total, "indexed": total - len(stale), "stale": len(stale),
                    "documents": n_docs, "notes": total - n_docs, "errors": len(errors), "notText": len(skipped),
                    "errorFiles": dict(list(errors.items())[:20]), "missing": documents.missing() if docs else {},
                    "skipped": sc["skipped"], "scanSeconds": sc["seconds"]}

    def file_list(self, root, model, docs=False, filter="all", q="", limit=300):
        """Where each file stands – indexed (chunks, when), waiting, changed, unreadable or not text – filtered and
        searched here so a vault with thousands of files sends only one page of rows."""
        with self.lock:
            st, cur, stale = self._sync(root, model, docs)
        sizes = documents.scan(root)["sizes"]
        stale_set, rows = set(stale), []
        for rel in cur:
            f = st["files"].get(rel) or {}
            if rel in stale_set:
                state = "changed" if f else "waiting"
            else:
                state = "skipped" if f.get("skip") else "error" if f.get("error") else "indexed"
            rows.append((state, rel, f))
        order = {"changed": 0, "waiting": 1, "error": 2, "indexed": 3, "skipped": 4}
        counts = {k: sum(1 for r in rows if r[0] == k) for k in order}
        want = {"all": ("changed", "waiting", "error", "indexed"), "waiting": ("changed", "waiting")}.get(filter, (filter,))
        ql = (q or "").strip().lower()
        hits = [r for r in rows if r[0] in want and (not ql or ql in r[1].lower() or ql in documents.kind(r[1]).lower())]
        hits.sort(key=lambda r: (order[r[0]], r[1].lower()))
        out = [{"path": rel, "kind": "Note" if rel.endswith(".md") else documents.kind(rel), "size": sizes.get(rel, 0), "state": state,
                "chunks": 0 if state in ("changed", "waiting", "skipped") else f.get("n", 0), "at": f.get("at"), "error": f.get("error") or f.get("skip") or ""}
               for state, rel, f in hits[:max(1, min(2000, int(limit or 300)))]]
        return {"files": out, "matched": len(hits), "counts": counts, "total": len(rows) - counts["skipped"],
                "chunks": sum(f.get("n", 0) for state, _, f in rows if state == "indexed"), "skipped": documents.scan(root)["skipped"]}

    def known_files(self, root):
        """{path: state entry} for files the index has seen (for listing files of unknown type without opening them)."""
        with self.lock:
            st = self._state()
            return dict(st.get("files", {})) if st.get("root") == str(root) else {}

    def chunks_for(self, root, rel, mtime=None):
        """(chunks, error) for one note or document, ready for the browser to embed."""
        p = Path(root) / rel
        if rel.endswith(".md"):
            return chunk_markdown(p.read_text(encoding="utf-8", errors="replace"), p.stem), None
        entry = self.texts.get(root, rel, mtime)
        if entry["error"] or not any(s["text"] for s in entry["sections"]):
            return [{"heading": "", "text": "", "embed": p.name}], entry["error"] or "no text found"  # still findable by name
        return chunk_document(entry["sections"], p.name), None

    def next_batch(self, root, model, limit=4, docs=False, skip=(), settle=0):
        """Stale files for the browser to embed. `skip`: already done in this pass (a file that keeps changing –
        a running solver job, a log – is taken once per pass); `settle`: leave already-indexed files that changed in the last N seconds alone until they stop changing."""
        with self.lock:  # reading documents happens outside the lock, so search keeps working during a long extraction
            st, cur, stale = self._sync(root, model, docs)
        skip, fresh = set(skip or ()), (time.time() - settle) * 1e9 if settle else None
        # only files that were indexed before and are changing again wait (a running solver job, a log); new files go straight in
        todo = [p for p in stale if p not in skip and not (fresh and cur[p] > fresh and p in st["files"])]
        files, n, not_text = [], 0, []
        for rel in todo[: max(limit, 1) * 8]:
            if len(files) >= limit or (files and n >= BATCH_CHUNKS):
                break
            if not rel.endswith(".md") and documents.needs_text_check(rel) and not documents.looks_like_text(Path(root) / rel, cur[rel]):
                not_text.append(rel)  # judged by its name it could be text, but it's binary: remember, and don't count it
                continue
            try:
                chunks, err = self.chunks_for(root, rel, cur[rel])
            except OSError:
                continue
            files.append({"path": rel, "mtime": str(cur[rel]), "chunks": chunks, "error": err})  # str: ns timestamps exceed JS number precision
            n += len(chunks)
        if not_text:
            with self.lock:
                st = self._checked_state(root, model)
                for rel in not_text:
                    st["files"][rel] = {"mtime": cur[rel], "n": 0, "skip": "not a text file"}
                self._save_state(st)
        skipped = len(self._skipped(st, cur)) if not not_text else len(self._skipped(self._state(), cur))
        remaining = len(stale) - len(not_text)
        return {"files": files, "remaining": remaining, "total": len(cur) - skipped, "settling": len(stale) - len(todo), "notText": len(not_text)}

    def upsert(self, root, model, path, mtime, chunks, error=None):
        with self.lock:
            st = self._checked_state(root, model)
            st["model"] = model
            tbl = self._table(create=True)
            tbl.delete(f"path = '{self._q(path)}'")
            rows = []
            for i, c in enumerate(chunks[:DOC_MAX_CHUNKS]):
                vec = c.get("vector") or []
                if len(vec) != DIM:
                    raise ValueError(f"expected {DIM}-dimension vectors, got {len(vec)}")
                rows.append({"path": path, "chunk": i, "heading": c.get("heading", ""), "text": c.get("text", ""), "vector": [float(x) for x in vec]})
            if rows:
                tbl.add(rows)
            st["files"][path] = {"mtime": int(mtime), "n": len(rows), "at": int(time.time()), **({"error": str(error)[:300]} if error else {})}
            self._save_state(st)
            self._writes += 1
            if self._writes % 50 == 0:  # compact deleted rows / old versions now and then
                try:
                    tbl.optimize(cleanup_older_than=timedelta(minutes=1))
                except Exception:
                    pass

    def similar_files(self, root, rel, k=15, exclude=None):
        """Files whose content is closest to `rel`, using its stored chunk vectors (None if it isn't indexed yet)."""
        with self.lock:
            st = self._state()
            if st.get("root") != str(root):
                return None
            tbl = self._table()
            if tbl is None:
                return None
            own = tbl.search().where(f"path = '{self._q(rel)}'").select(["vector"]).limit(DOC_MAX_CHUNKS).to_list()
            if not own:
                return None
            mean = [sum(r["vector"][i] for r in own) / len(own) for i in range(DIM)]
            norm = sum(x * x for x in mean) ** 0.5 or 1
            where = f"path != '{self._q(rel)}'" + (f" AND path NOT LIKE '{self._q(exclude.strip('/'))}/%'" if exclude else "")
            rows = tbl.search([x / norm for x in mean]).distance_type("cosine").where(where, prefilter=True).limit(k * 8).to_list()
        best = {}
        for r in rows:
            if r["path"] not in best or r["_distance"] < best[r["path"]]["_distance"]:
                best[r["path"]] = r
        hits = sorted(best.values(), key=lambda r: r["_distance"])[:k]
        return [{"path": r["path"], "heading": r["heading"], "score": round(1 - r["_distance"], 3)} for r in hits]

    def search(self, root, vector, k=8, folder=None):
        with self.lock:
            st = self._state()
            if st.get("root") != str(root):
                return []
            tbl = self._table()
            if tbl is None or len(vector or []) != DIM:
                return []
            q = tbl.search([float(x) for x in vector]).distance_type("cosine")
            if folder:
                q = q.where(f"path LIKE '{self._q(folder.strip('/'))}/%'", prefilter=True)
            rows = q.limit(k * 4).to_list()
        best = {}
        for r in rows:  # best chunk per note
            if r["path"] not in best or r["_distance"] < best[r["path"]]["_distance"]:
                best[r["path"]] = r
        hits = sorted(best.values(), key=lambda r: r["_distance"])[:k]
        return [{"path": r["path"], "heading": r["heading"], "text": r["text"], "score": round(1 - r["_distance"], 3)} for r in hits]
