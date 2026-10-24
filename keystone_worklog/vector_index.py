"""Semantic index of the vault, stored on disk with LanceDB.

Embeddings are computed in the browser (a small local model), so this module only
chunks notes and documents (PDF, Word, PowerPoint, Excel, emails, text – see documents.py),
tracks which ones are stale, stores vectors and answers nearest-neighbour queries.
If LanceDB isn't installed, `available` is False and the app falls back to keyword search.
"""
import json
import os
import re
import shutil
import threading
import time
from datetime import timedelta
from pathlib import Path

from . import documents

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
    "hf": [_MODEL + f for f in ("config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx")],
    "cdn": [_RUNTIME + f for f in ("transformers.min.js", "ort-wasm-simd-threaded.jsep.wasm")],
}
TABLE = "chunks"
FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
MAX_CHARS, OVERLAP, MAX_CHUNKS = 800, 120, 200
DOC_MAX_CHUNKS = 2500   # documents can be long: a 600-page PDF is ~2,000 chunks
BATCH_CHUNKS = 300      # roughly how many chunks one /api/index/next hands to the browser


def vault_notes(root):
    """{relative path: mtime_ns} for every visible .md note in the vault."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in filenames:
            if f.endswith(".md") and not f.startswith("."):
                p = Path(dirpath) / f
                try:
                    out[p.relative_to(root).as_posix()] = p.stat().st_mtime_ns
                except OSError:
                    pass
    return out


def vault_files(root, docs=False):
    """Notes, plus documents when `docs` is on: {relative path: mtime_ns}."""
    out = vault_notes(root)
    if docs:
        out.update(documents.vault_documents(root))
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

    # ---------- state ----------
    def _state(self):
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_state(self, st):
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(st), encoding="utf-8")
        os.replace(tmp, self.state_path)

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
        stale = [p for p, m in cur.items() if st["files"].get(p, {}).get("mtime") != m]
        stale.sort(key=lambda p: (not p.endswith(".md"), -cur[p]))  # notes are quick: do them first
        return st, cur, stale

    def status(self, root, model, docs=False):
        with self.lock:
            st, cur, stale = self._sync(root, model, docs)
            n_docs = sum(1 for p in cur if not p.endswith(".md"))
            errors = {p: f["error"] for p, f in st["files"].items() if f.get("error") and p in cur}
            return {"available": True, "total": len(cur), "indexed": len(cur) - len(stale), "stale": len(stale),
                    "documents": n_docs, "notes": len(cur) - n_docs, "errors": len(errors),
                    "errorFiles": dict(list(errors.items())[:20]), "missing": documents.missing() if docs else {}}

    def file_list(self, root, model, docs=False):
        """Every file the index covers and where it stands: indexed (chunks, when), waiting, changed, or unreadable."""
        with self.lock:
            st, cur, stale = self._sync(root, model, docs)
        stale_set, rows = set(stale), []
        for rel, m in cur.items():
            f = st["files"].get(rel) or {}
            if rel in stale_set:
                state = "changed" if f else "waiting"
            else:
                state = "error" if f.get("error") else "indexed"
            try:
                size = (Path(root) / rel).stat().st_size
            except OSError:
                size = 0
            rows.append({"path": rel, "kind": "Note" if rel.endswith(".md") else documents.kind(rel), "size": size, "state": state,
                         "chunks": 0 if rel in stale_set else f.get("n", 0), "at": f.get("at"), "error": f.get("error", "")})
        order = {"changed": 0, "waiting": 1, "error": 2, "indexed": 3}
        rows.sort(key=lambda r: (order[r["state"]], r["path"].lower()))
        counts = {k: sum(1 for r in rows if r["state"] == k) for k in order}
        return {"files": rows, "counts": counts, "total": len(rows), "chunks": sum(r["chunks"] for r in rows)}

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
        files, n = [], 0
        for rel in todo[: max(limit, 1) * 4]:
            if len(files) >= limit or (files and n >= BATCH_CHUNKS):
                break
            try:
                chunks, err = self.chunks_for(root, rel, cur[rel])
            except OSError:
                continue
            files.append({"path": rel, "mtime": str(cur[rel]), "chunks": chunks, "error": err})  # str: ns timestamps exceed JS number precision
            n += len(chunks)
        return {"files": files, "remaining": len(stale), "total": len(cur), "settling": len(stale) - len(todo)}

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
