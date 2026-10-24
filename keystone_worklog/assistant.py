"""Keystone assistant back end: provider profiles, chat proxy, vault tools, undo and git.

The agent loop itself runs in the browser (it needs the in-browser embedding model);
this module keeps API keys on the server, forwards chat requests to any
OpenAI-compatible /chat/completions endpoint, and performs every file action inside
the vault. There is deliberately no delete tool.
"""
import collections
import difflib
import json
import os
import re
import secrets
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import documents, vault

READ_LIMIT = 20000
# common words left out of keyword search, so "when can the crew start" matches on "crew" and "start"
STOP_WORDS = set("""a an and are as at be been but by can could did do does for from had has have how i if in into is it its
me my no not of on or our so than that the their them then there these they this to too up us was we were what when where which
who whom why will with would you your about after all also any before between both each find get just more most much
other over same should some such through under very want document documents file files note notes show tell""".split())
UNDO_KEEP = 100


class ToolError(Exception):
    """A problem the model should read and recover from."""


class LLMError(Exception):
    pass


# ---------- settings (data/llm.json, never sent to the browser with keys) ----------
DEFAULTS = {"profiles": [], "active": None, "autoApply": False, "gitCommit": True, "semantic": True, "documents": True, "plainText": True, "maxSteps": 12}
PROFILE_KEYS = ("id", "name", "baseUrl", "apiKey", "model", "trackerAccess", "stream", "temperature")


def load_settings(path):
    try:
        s = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        s = {}
    return {**DEFAULTS, **s}


def save_settings(path, s):
    path = Path(path)
    path.parent.mkdir(exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # owner-only: holds API keys
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)
    os.replace(tmp, path)


def mask(key):
    return f"{key[:3]}…{key[-4:]}" if key and len(key) > 10 else ("•••" if key else "")


def public_settings(s):
    out = {k: v for k, v in s.items() if k != "profiles"}
    out["profiles"] = [{**{k: p.get(k) for k in PROFILE_KEYS if k != "apiKey"}, "hasKey": bool(p.get("apiKey")), "keyHint": mask(p.get("apiKey"))}
                       for p in s["profiles"]]
    return out


def merge_settings(s, incoming):
    """Apply edits from the browser. An empty apiKey keeps the saved one; clearKey removes it."""
    for k in ("autoApply", "gitCommit", "semantic", "documents", "plainText"):
        if k in incoming:
            s[k] = bool(incoming[k])
    if "maxSteps" in incoming:
        s["maxSteps"] = max(1, min(40, int(incoming.get("maxSteps") or 12)))
    if "profiles" in incoming:
        old = {p["id"]: p for p in s["profiles"]}
        profiles = []
        for p in incoming["profiles"]:
            pid = p.get("id") or secrets.token_hex(4)
            prev = old.get(pid, {})
            key = prev.get("apiKey", "")
            if p.get("clearKey"):
                key = ""
            elif p.get("apiKey"):
                key = p["apiKey"].strip()
            profiles.append({"id": pid, "name": (p.get("name") or "Untitled").strip()[:60], "baseUrl": (p.get("baseUrl") or "").strip().rstrip("/"),
                             "apiKey": key, "model": (p.get("model") or "").strip(), "trackerAccess": bool(p.get("trackerAccess")),
                             "stream": p.get("stream", True) is not False, "temperature": p.get("temperature")})
        s["profiles"] = profiles
    if "active" in incoming:
        s["active"] = incoming["active"]
    if s["profiles"] and s.get("active") not in {p["id"] for p in s["profiles"]}:
        s["active"] = s["profiles"][0]["id"]
    return s


def get_profile(s, pid):
    for p in s["profiles"]:
        if p["id"] == pid:
            return p
    raise LLMError("Choose an assistant profile in Settings first.")


# ---------- talking to the model ----------
def _request(profile, path, body=None, timeout=600):
    base = profile.get("baseUrl") or ""
    if not re.match(r"^https?://", base):
        raise LLMError("The base URL must start with http:// or https://")
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream" if body and body.get("stream") else "application/json"}
    if profile.get("apiKey"):
        headers["Authorization"] = f"Bearer {profile['apiKey']}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers=headers, method="POST" if data else "GET")
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        try:
            j = json.loads(detail)
            detail = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else j.get("error") or j.get("message") or detail
        except ValueError:
            pass
        raise LLMError(f"{profile.get('name')}: HTTP {e.code} – {detail}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise LLMError(f"Can't reach {base}: {getattr(e, 'reason', e)}") from None


def chat(profile, messages, tools, stream):
    body = {"model": profile.get("model"), "messages": messages, "stream": bool(stream)}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if profile.get("temperature") not in (None, ""):
        body["temperature"] = float(profile["temperature"])
    return _request(profile, "/chat/completions", body)


def list_models(profile):
    with _request(profile, "/models", timeout=20) as r:
        j = json.loads(r.read().decode("utf-8"))
    return sorted(m.get("id") for m in j.get("data", []) if m.get("id"))


def test_profile(profile):
    """Check the endpoint answers and the model can call tools (the assistant depends on it)."""
    tool = {"type": "function", "function": {"name": "get_time", "description": "Returns the current time.",
                                             "parameters": {"type": "object", "properties": {}}}}
    t0 = time.time()
    with chat({**profile, "temperature": 0}, [{"role": "user", "content": "What time is it? Use the get_time tool."}], [tool], False) as r:
        j = json.loads(r.read().decode("utf-8"))
    msg = (j.get("choices") or [{}])[0].get("message") or {}
    return {"ok": True, "toolCalls": bool(msg.get("tool_calls")), "seconds": round(time.time() - t0, 1), "reply": (msg.get("content") or "")[:200]}


# ---------- git (auto-commit each assistant change) ----------
def _git(root, *args, timeout=30):
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=timeout)


def git_status(root):
    if not shutil.which("git"):
        return {"git": False, "repo": False}
    r = _git(root, "rev-parse", "--show-toplevel")
    if r.returncode:
        return {"git": True, "repo": False}
    last = _git(root, "log", "-1", "--format=%h %s")
    branch = _git(root, "branch", "--show-current")
    return {"git": True, "repo": True, "top": r.stdout.strip(), "branch": branch.stdout.strip(), "last": last.stdout.strip()}


def _identity(root):
    has = _git(root, "config", "user.email").returncode == 0 and _git(root, "config", "user.name").returncode == 0
    return [] if has else ["-c", "user.name=NWA Assistant", "-c", "user.email=nwa-assistant@localhost"]


def git_init(root):
    if not shutil.which("git"):
        raise ToolError("Git is not installed")
    if _git(root, "rev-parse", "--show-toplevel").returncode == 0:
        return git_status(root)
    _git(root, "init")
    gi = Path(root) / ".gitignore"
    if not gi.exists():
        gi.write_text(".trash/\n.obsidian/workspace*.json\n.obsidian/cache\n.DS_Store\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, *_identity(root), "commit", "-m", "Vault snapshot before NWA Assistant")
    return git_status(root)


def git_commit_moves(root, moves, message):
    """Commit moved files only where git already tracked them – moving a big untracked file (an .odb, a PDF)
    must not suddenly add it to the repository."""
    if _git(root, "rev-parse", "--show-toplevel").returncode:
        return None
    paths = []
    for src, dst in moves:
        if _git(root, "ls-files", "--error-unmatch", "--", src).returncode == 0:
            paths += [src, dst]
    return git_commit(root, paths, message) if paths else None


def git_commit(root, paths, message):
    """Commit only `paths` (other uncommitted work in the vault is left alone). Returns short hash or None."""
    if _git(root, "rev-parse", "--show-toplevel").returncode:
        return None
    add = _git(root, "add", "-A", "--", *paths)
    if add.returncode:
        return None
    r = _git(root, *_identity(root), "commit", "-m", message, "--", *paths)
    if r.returncode:
        return None
    return _git(root, "rev-parse", "--short", "HEAD").stdout.strip() or None


# ---------- vault tools ----------
class Tools:
    def __init__(self, root, resolve, tracker_folder, undo_dir, index=None, git_on=True, texts=None, docs=False, inbox="Inbox", capture="Today.md"):
        self.root = Path(root)
        self.resolve = resolve  # (rel, md) -> (root, Path); enforces vault-only paths
        self.tracker = tracker_folder.strip("/")
        self.undo_dir = Path(undo_dir)
        self.index = index
        self.git_on = git_on
        self.texts = texts      # documents.TextCache: extracted text of PDFs, Office files, emails…
        self.docs = bool(docs and texts is not None)  # search documents too (Settings → AI assistant)
        self.inbox = (inbox or "Inbox").strip("/")       # the folder new files land in, to be filed
        self.capture = (capture or "Today.md").strip("/")  # the quick-capture note: a scratchpad, never a filing hint

    def rel(self, p):
        return p.relative_to(self.root).as_posix()

    def note(self, path):
        path = (path or "").strip().lstrip("/")
        if not path.lower().endswith(".md"):
            path += ".md"
        return self.resolve(path, True)[1]

    def read(self, p):
        return p.read_text(encoding="utf-8", errors="replace")

    def is_tracker(self, p):
        return self.rel(p).startswith(self.tracker + "/")

    # ----- read-only -----
    def list_folder(self, path=""):
        base = self.resolve(path.strip("/"), False)[1] if path.strip("/") else self.root
        if not base.is_dir():
            raise ToolError(f"No folder named '{path}'")
        dirs, notes, docs = [], [], []
        for c in sorted(base.iterdir(), key=lambda c: c.name.lower()):
            if c.name.startswith("."):
                continue
            if c.is_dir():
                dirs.append(c.name + "/")
            elif c.suffix.lower() == ".md":
                notes.append(c.name)
            elif self.docs and documents.is_document(c):
                docs.append(c.name)
        where = self.rel(base) if base != self.root else "(vault root)"
        out = f"{where}\nFolders: {', '.join(dirs) or 'none'}\nNotes: {', '.join(notes[:300]) or 'none'}" + (" …" if len(notes) > 300 else "")
        if docs:
            out += f"\nDocuments (read with read_document): {', '.join(docs[:300])}" + (" …" if len(docs) > 300 else "")
        return out

    def read_note(self, path, start_line=None, end_line=None):
        bare = (path or "").strip().lstrip("/").split("#", 1)[0]
        if Path(bare).suffix and not bare.lower().endswith(".md"):
            if self.docs and documents.is_document(self.resolve(bare, False)[1]):
                return self.read_document(bare)
        p = self.note(path)
        if not p.is_file():
            raise ToolError(f"Note not found: {path}. Use search_notes or list_folder to find the right path.")
        lines = self.read(p).splitlines()
        a = max(1, int(start_line or 1))
        b = min(len(lines), int(end_line or len(lines)))
        body = "\n".join(lines[a - 1:b])
        cut = len(body) > READ_LIMIT
        head = f"{self.rel(p)} (lines {a}-{b} of {len(lines)})" + (" — tracker note: the block between nwa-tracker markers is generated, don't edit it" if self.is_tracker(p) else "")
        return f"{head}\n---\n{body[:READ_LIMIT]}" + (f"\n… [truncated; read more with start_line={a + body[:READ_LIMIT].count(chr(10)) + 1}]" if cut else "")

    def keyword_search(self, query, folder=None, limit=8):
        words = [w for w in re.findall(r"[\w$\\-]{2,}", query.lower())]
        words = [w for w in words if w not in STOP_WORDS][:12] or words[:12]
        if not words:
            return []
        phrase = query.lower().strip()
        base = self.resolve(folder.strip("/"), False)[1] if folder and folder.strip("/") else self.root
        hits = []
        for rel_path in vault_paths(base, self.root):
            p = self.root / rel_path
            try:
                text = self.read(p)
            except OSError:
                continue
            low, title = text.lower(), p.stem.lower()
            score = sum(min(low.count(w), 20) for w in words) + 6 * sum(w in title for w in words) + (10 if len(phrase) > 4 and phrase in low else 0)
            if not score:
                continue
            i = low.find(words[0]) if words[0] in low else next((low.find(w) for w in words if w in low), 0)
            snippet = text[max(0, i - 120): i + 220].replace("\n", " ").strip()
            hits.append({"path": rel_path, "heading": "", "text": snippet, "score": score})
        if self.docs:
            hits += self.keyword_search_documents(words, phrase, folder)
        hits.sort(key=lambda h: -h["score"])
        return hits[:limit]

    def keyword_search_documents(self, words, phrase, folder=None):
        """Keyword hits in documents whose text has been extracted (indexing extracts them; the rest are warmed in the background)."""
        prefix = folder.strip("/") + "/" if folder and folder.strip("/") else ""
        hits, missing, budget = [], False, time.monotonic() + 3  # read uncached documents for up to ~3 s, the rest in the background
        for rel_path, m in sorted(documents.vault_documents(self.root).items(), key=lambda x: -x[1]):
            if prefix and not rel_path.startswith(prefix):
                continue
            entry = self.texts.cached(self.root, rel_path, m)
            if entry is None and time.monotonic() < budget:
                entry = self.texts.get(self.root, rel_path, m)
            if entry is None:
                missing = True
            title = Path(rel_path).name.lower()
            name_score = 6 * sum(w in title for w in words)
            best, total = None, name_score
            for sec in (entry or {}).get("sections", []):
                low = sec["text"].lower()
                sc = sum(min(low.count(w), 20) for w in words) + (10 if len(phrase) > 4 and phrase in low else 0)
                total += sc
                if sc and (best is None or sc > best[0]):
                    best = (sc, sec, low)
            if not total:
                continue
            if best:
                _, sec, low = best
                i = next((low.find(w) for w in words if w in low), 0)
                snippet, heading = sec["text"][max(0, i - 120): i + 220].replace("\n", " ").strip(), sec["heading"]
            else:
                snippet, heading = "(matched the file name)", ""
            hits.append({"path": rel_path, "heading": heading, "text": snippet, "score": total})
        if missing:
            self.texts.warm(self.root)
        return hits

    def search_notes(self, query, folder=None, limit=8, vector=None):
        limit = max(1, min(20, int(limit or 8)))
        kw = self.keyword_search(query, folder, limit * 2)
        sem = self.index.search(self.root, vector, limit * 2, folder) if (self.index and vector) else []
        merged = {}
        for source, rows in (("keyword", kw), ("meaning", sem)):
            for rank, r in enumerate(rows):  # reciprocal rank fusion
                m = merged.setdefault(r["path"], {"path": r["path"], "score": 0.0, "via": set(), "heading": "", "text": "", "also": ""})
                m["score"] += 1 / (60 + rank)
                m["via"].add(source)
                if source == "meaning" or not m["text"]:
                    if source == "meaning" and m["heading"] and m["heading"] != r["heading"]:
                        m["also"] = m["heading"]  # the keyword match is somewhere else in the file: mention both
                    m["heading"], m["text"] = r["heading"], r["text"]
        rows = sorted(merged.values(), key=lambda m: -m["score"])[:limit]
        if not rows:
            return f"Nothing in the vault matched “{query}”." + ("" if vector else " (Keyword search only – the meaning index isn't ready.)")
        out = []
        for i, m in enumerate(rows, 1):
            is_note = m["path"].lower().endswith(".md")
            name = Path(m["path"]).stem if is_note else Path(m["path"]).name
            page = re.match(r"(?:.* › )?Page (\d+)$", m["heading"] or "")
            link = f"[[{name}#page={page.group(1)}]]" if page and name.lower().endswith(".pdf") else f"[[{name}]]"
            where = (f" › {m['heading']}" if m["heading"] else "") + (f" (keywords also on: {m['also']})" if m.get("also") else "")
            what = "" if is_note else f"{documents.kind(m['path'])}; "
            snippet = re.sub(r"\s+", " ", m["text"])[:300]
            out.append(f"{i}. {link} — {m['path']}{where} ({what}{'+'.join(sorted(m['via']))})\n   {snippet}")
        return "\n".join(out)

    def read_document(self, path, start_part=None, end_part=None):
        """Text of a PDF / Word / PowerPoint / Excel / email / text file, by numbered parts (pages, slides, sheets…)."""
        path = (path or "").strip().lstrip("/").split("#", 1)[0]
        if not self.docs:
            raise ToolError("Document search is turned off in Settings → AI assistant.")
        p = self.resolve(path, False)[1]
        if not p.is_file():
            raise ToolError(f"Document not found: {path}. Use search_notes or list_folder to find the right path.")
        if not documents.is_document(p):
            label = documents.kind(path)
            if label in documents.missing():
                raise ToolError(f"Reading {label} files needs the {documents.missing()[label]} package on this computer (pip install \"keystone-worklog[documents]\"). Tell the user.")
            raise ToolError(f"{path} isn't a file Keystone can read (binary, or an unsupported format). Notes (.md) are read with read_note.")
        entry = self.texts.get(self.root, self.rel(p))
        if entry["error"]:
            raise ToolError(f"Couldn't read {self.rel(p)}: {entry['error']}.")
        parts = entry["sections"]
        n = len(parts)
        a = max(1, int(start_part or 1))
        b = min(n, int(end_part or n))
        body, last = [], a - 1
        for i in range(a, b + 1):
            s = parts[i - 1]
            block = f"[Part {i}{' – ' + s['heading'] if s['heading'] else ''}]\n{s['text']}"
            if body and sum(len(x) for x in body) + len(block) > READ_LIMIT:
                break
            body.append(block[:READ_LIMIT])
            last = i
        head = f"{self.rel(p)} ({documents.kind(p)}; parts {a}-{last} of {n})"
        more = f"\n… [more: read_document with start_part={last + 1}]" if last < b else ""
        return f"{head}\n---\n" + "\n\n".join(body) + more

    # ----- filing: the vault's structure, where a file belongs, moving files -----
    def _walk_files(self):
        """(relative path, folder) for every visible file, notes and documents alike (cached per request)."""
        if getattr(self, "_files", None) is None:
            self._files = []
            for dirpath, dirnames, filenames in os.walk(self.root):
                dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in ("__pycache__", "node_modules", ".ipynb_checkpoints"))
                rel_dir = Path(dirpath).relative_to(self.root).as_posix()
                for f in filenames:
                    if not f.startswith((".", "~$")):
                        self._files.append((f"{rel_dir}/{f}" if rel_dir != "." else f, "" if rel_dir == "." else rel_dir))
        return self._files

    def _folder_note(self, folder):
        """A folder's own description: <folder>/<folder name>.md, README.md, index.md or _about.md."""
        name = Path(folder).name if folder else ""
        for cand in ([f"{name}.md"] if name else []) + ["README.md", "Readme.md", "index.md", "_about.md", "About.md"]:
            p = self.root / folder / cand
            if p.is_file():
                lines = [l.strip() for l in self.read(p).splitlines() if l.strip() and not l.startswith(("#", "---", "<!--")) and ":" not in l[:20]]
                text = re.sub(r"\s+", " ", " ".join(lines))[:200]
                if text:
                    return text
        return ""

    def vault_map(self, folder="", depth=3):
        depth = max(1, min(6, int(depth or 3)))
        base = folder.strip("/")
        if base and not self.resolve(base, False)[1].is_dir():
            raise ToolError(f"No folder named '{folder}'")
        stats = {}
        for rel, d in self._walk_files():
            if base and not (d == base or d.startswith(base + "/")):
                continue
            node = stats.setdefault(d, {"notes": 0, "files": 0, "names": []})
            if rel.lower().endswith(".md"):
                node["notes"] += 1
            else:
                node["files"] += 1
            node["names"].append(Path(rel).name)
        dirs = set(stats)
        for d in list(dirs):  # make sure every ancestor appears
            parts = d.split("/") if d else []
            for i in range(1, len(parts)):
                dirs.add("/".join(parts[:i]))
        start = len(base.split("/")) if base else 0
        lines, hidden = [], 0
        for d in sorted(dirs, key=lambda x: x.lower()):
            if base and not (d == base or d.startswith(base + "/")):
                continue
            level = (len(d.split("/")) if d else 0) - start
            if level > depth:
                hidden += 1
                continue
            st = stats.get(d, {"notes": 0, "files": 0, "names": []})
            below = sum(1 for x in dirs if x.startswith(d + "/")) if d else 0
            tag = " (time tracker – generated)" if d == self.tracker or d.startswith(self.tracker + "/") else " (INBOX – files waiting to be filed)" if d == self.inbox else ""
            counts = ", ".join(x for x in (f"{st['notes']} notes" if st["notes"] else "", f"{st['files']} files" if st["files"] else "") if x) or "empty"
            sample = ", ".join(sorted(st["names"], key=str.lower)[:6]) + (" …" if len(st["names"]) > 6 else "") if st["names"] else ""
            about = self._folder_note(d)
            lines.append(f"{'  ' * max(0, level)}{d or '(vault root)'}/ — {counts}{f', {below} subfolders' if below and level == depth else ''}{tag}"
                         + (f"\n{'  ' * max(0, level)}   e.g. {sample}" if sample else "") + (f"\n{'  ' * max(0, level)}   about: {about}" if about else ""))
        rules = next((rel for rel, _ in self._walk_files() if Path(rel).name.lower() == "filing rules.md"), None)
        out = "\n".join(lines)
        if len(out) > READ_LIMIT:
            out = out[:READ_LIMIT] + f"\n… [cut; call vault_map with a folder to see more]"
        return (f"Folders{' under ' + base if base else ''} (depth {depth}{f', {hidden} deeper folders not shown' if hidden else ''}):\n" + out
                + (f"\n\nFiling rules note: {rules} – read it with read_note before filing." if rules else "\n\nNo 'Filing rules' note yet."))

    @staticmethod
    def _job_stem(name):
        """'girder_v3.inp' → 'girder'; 'Bridge spec rev B (2).pdf' → 'bridge spec' – to match versions of the same thing."""
        stem = Path(name).stem.lower()
        return re.sub(r"[\s_.-]*(\(\d+\)|v\d+[a-z]?|rev[\s_.-]*\w{1,3}|r\d+|final|draft|copy|\d{4}-\d{2}-\d{2}|\d{6,8})$", "", stem).strip(" _-.") or stem

    def folder_suggestions(self, rel, limit=3):
        """Where a file probably belongs: folders of files with similar content, plus files with the same (job) name."""
        p = self.resolve(rel, False)[1]
        if not p.is_file():
            raise ToolError(f"File not found: {rel}")
        rel = self.rel(p)
        own_dir, stem, job = Path(rel).parent.as_posix(), p.stem.lower(), self._job_stem(p.name)
        skip = lambda d: d == self.inbox or d.startswith(self.inbox + "/") or d == self.tracker or d.startswith(self.tracker + "/")  # noqa: E731
        hits = []  # (folder, weight 0..1, raw similarity, reason)
        for other, d in self._walk_files():  # same name / same job name elsewhere in the vault
            if other == rel or skip(d) or d == own_dir:
                continue
            o = Path(other)
            if o.stem.lower() == stem:
                hits.append((d, 1.0, 1.0, f"has {o.name}"))
            elif len(job) >= 4 and self._job_stem(o.name) == job:
                hits.append((d, 0.8, 0.8, f"has {o.name}"))
        name_words = {w for w in re.findall(r"[a-z][a-z0-9]{3,}", Path(rel).stem.lower()) if w not in STOP_WORDS}
        if name_words:  # words of the file name in a folder's own name: "runway edge lights.csv" → Projects/Runway Lighting
            for d in {d for _, d in self._walk_files() if d and not skip(d) and d != own_dir}:
                common = name_words & set(re.findall(r"[a-z][a-z0-9]{3,}", Path(d).name.lower()))
                if common:
                    hits.append((d, 0.5 * len(common), 0.5, f"folder name matches “{sorted(common)[0]}”"))
        sims = self.index.similar_files(self.root, rel, 16, self.inbox) if self.index else None
        if sims:
            sims = [x for x in sims if x["path"] != self.capture][:15]
            # only matches clearly above the background count: weight = how far above the median similarity
            scores = sorted(x["score"] for x in sims)
            floor = scores[len(scores) // 2] if len(scores) >= 4 else 0.0
            for x in sims:
                d = Path(x["path"]).parent.as_posix()
                d = "" if d == "." else d
                w = (x["score"] - floor) / max(1e-6, 1 - floor)
                if w > 0 and not skip(d) and d != own_dir:
                    hits.append((d, w, x["score"], f"similar to {Path(x['path']).name}"))
        else:  # not embedded yet: fall back to keyword search on its most telling words
            text = ""
            if p.suffix.lower() == ".md":
                text = self.read(p)
            elif self.texts is not None and documents.is_document(p):
                text = " ".join(x["text"] for x in self.texts.get(self.root, rel)["sections"])[:20000]
            words = [w for w in re.findall(r"[a-z][a-z0-9-]{3,}", text.lower()) if w not in STOP_WORDS]
            common = [w for w, _ in collections.Counter(words).most_common(8)]
            for rank, h in enumerate(self.keyword_search(" ".join(common), None, 10) if common else []):
                d = Path(h["path"]).parent.as_posix()
                d = "" if d == "." else d
                if not skip(d) and d != own_dir and h["path"] != rel:
                    hits.append((d, 0.6 / (1 + rank * 0.5), 0.5 if rank < 3 else 0.35, f"shares words with {Path(h['path']).name}"))
        hits = [(d, w * 0.3 if d == "" else w, raw, why) for d, w, raw, why in hits]  # the vault root is rarely where a file belongs
        votes = {}
        for d, w, raw, why in sorted(hits, key=lambda x: -x[1]):  # diminishing returns per folder: a big folder can't win by volume
            v = votes.setdefault(d, {"folder": d, "score": 0.0, "n": 0, "best": 0.0, "why": []})
            v["score"] += w * 0.5 ** v["n"]
            v["n"] += 1
            v["best"] = max(v["best"], raw)
            if len(v["why"]) < 3 and why not in v["why"]:
                v["why"].append(why)
        ranked = sorted(votes.values(), key=lambda v: -v["score"])
        total = sum(v["score"] for v in ranked) or 1
        for v in ranked:
            v["share"] = round(v["score"] / total, 2)
            v["score"] = round(v["score"], 3)
            v.pop("n")
        top = ranked[0] if ranked else None
        if not top or top["best"] < 0.3:
            conf = "none"
        elif top["best"] >= 0.95 or (top["best"] >= 0.6 and top["share"] >= 0.45):
            conf = "high"
        elif top["best"] >= 0.45 and top["share"] >= 0.3:
            conf = "medium"
        else:
            conf = "low"
        return {"path": rel, "kind": "Note" if rel.lower().endswith(".md") else documents.kind(rel), "suggestions": ranked[:max(1, limit)],
                "confidence": conf, "byContent": bool(sims), "job": job}

    def suggest_folder(self, path, limit=3):
        r = self.folder_suggestions((path or "").strip().lstrip("/"), limit)
        if not r["suggestions"]:
            return f"No good match for {r['path']} – nothing similar is filed yet. Use vault_map and the file's contents to decide, or ask the user."
        how = "by its contents and name" if r["byContent"] else "by name and keywords (it isn't embedded yet)"
        rows = [f"{i}. {s['folder'] or '(vault root)'}/  — {int(s['share'] * 100)}% · {'; '.join(s['why'])}" for i, s in enumerate(r["suggestions"], 1)]
        return f"Where {r['path']} probably belongs, {how} (confidence: {r['confidence']}):\n" + "\n".join(rows)

    def inbox_suggestions(self, paths=None):
        """Suggestions for every file in the inbox (or `paths`); files of the same job (same name) share one destination."""
        if paths is None:
            paths = [rel for rel, d in self._walk_files() if d == self.inbox or d.startswith(self.inbox + "/")]
        rows = []
        for rel in paths[:300]:
            try:
                rows.append(self.folder_suggestions(rel, 4))
            except ToolError:
                continue
        groups = {}
        for r in rows:
            groups.setdefault((Path(r["path"]).parent.as_posix(), Path(r["path"]).stem.lower()), []).append(r)
        for g in groups.values():
            if len(g) < 2:
                continue
            pooled = {}
            for r in g:
                for s in r["suggestions"]:
                    pooled[s["folder"]] = pooled.get(s["folder"], 0) + s["score"]
            best = max(pooled, key=pooled.get) if pooled else None
            for r in g:
                r["group"] = [Path(x["path"]).name for x in g if x is not r]
                if best is not None and (not r["suggestions"] or r["suggestions"][0]["folder"] != best):
                    hit = next((s for s in r["suggestions"] if s["folder"] == best), None) or {"folder": best, "score": 0, "share": 0, "why": []}
                    r["suggestions"] = [hit] + [s for s in r["suggestions"] if s is not hit]
                    r["suggestions"][0]["why"] = (r["suggestions"][0]["why"] + ["kept with the rest of this job"])[:3]
        return {"inbox": self.inbox, "files": rows}

    def plan_move_files(self, moves):
        if not isinstance(moves, list) or not moves:
            raise ToolError("moves must be a list of {from, to}.")
        if len(moves) > 300:
            raise ToolError("At most 300 files per move.")
        out, seen = [], set()
        for i, m in enumerate(moves, 1):
            if not isinstance(m, dict):
                raise ToolError(f"Move {i}: expected {{from, to}}.")
            frm, to = str(m.get("from") or "").strip().lstrip("/"), str(m.get("to") or "").strip().lstrip("/")
            src = self.resolve(frm, False)[1]
            if not src.is_file():
                raise ToolError(f"Move {i}: {frm} not found.")
            if to in ("", ".") or to.endswith("/") or (self.root / to).is_dir() or not Path(to).suffix:
                dst = self.resolve(f"{to.rstrip('/')}/{src.name}" if to.strip("/.") else src.name, False)[1]
            else:
                dst = self.resolve(to, False)[1]
            if dst.suffix.lower() != src.suffix.lower():
                raise ToolError(f"Move {i}: {src.name} would change its type to {dst.suffix or 'nothing'}; keep the extension.")
            if dst == src:
                continue
            if dst.exists() or self.rel(dst) in seen:
                raise ToolError(f"Move {i}: {self.rel(dst)} already exists. Files are never overwritten – pick another folder or name.")
            if self.is_tracker(src) or self.is_tracker(dst):
                raise ToolError(f"Move {i}: files in '{self.tracker}' are managed by the tracker.")
            seen.add(self.rel(dst))
            out.append({"from": self.rel(src), "to": self.rel(dst), "newFolder": not dst.parent.exists(),
                        "reason": str(m.get("reason") or "")[:200], "confidence": str(m.get("confidence") or "")[:10].lower()})
        if not out:
            raise ToolError("Nothing to move – every file is already where it was asked to go.")
        return {"kind": "moves", "moves": out, "path": "", "summary": f"Move {len(out)} file{'s' if len(out) > 1 else ''}" + (f" from {self.inbox}" if all(x['from'].startswith(self.inbox + '/') for x in out) else "")}

    def recent_notes(self, days=7, limit=30):
        days, limit = max(1, min(90, int(days or 7))), max(1, min(100, int(limit or 30)))
        cutoff, rows = time.time() - days * 86400, []
        for rp in vault_paths(self.root, self.root):
            try:
                m = (self.root / rp).stat().st_mtime
            except OSError:
                continue
            if m >= cutoff:
                rows.append((m, rp))
        rows.sort(reverse=True)
        if not rows:
            return f"No notes changed in the last {days} days."
        return f"Notes changed in the last {days} days, newest first:\n" + "\n".join(
            f"- {time.strftime('%a %Y-%m-%d %H:%M', time.localtime(m))}  {rp}" + ("  (tracker note)" if rp.startswith(self.tracker + "/") else "")
            for m, rp in rows[:limit])

    def list_templates(self, folder):
        tdir = self.resolve(folder.strip("/"), False)[1] if folder.strip("/") else None
        if not tdir or not tdir.is_dir():
            return f"No templates folder ('{folder}')."
        names = [self.rel(f) for f in sorted(tdir.rglob("*.md"))]
        return "Templates (read one with read_note, fill it in, then create_note):\n" + ("\n".join(names) or "none")

    # ----- write plans: computed fresh for preview and again at apply time -----
    def _region(self, text):
        m = vault.REGION.search(text)
        return (m.start(), m.end()) if m else None

    def plan_create(self, path, content):
        p = self.note(path)
        if p.exists():
            raise ToolError(f"{self.rel(p)} already exists. Use edit_note or append_to_note to change it.")
        if self.is_tracker(p):
            raise ToolError(f"The '{self.tracker}' folder is managed by the tracker. Create the note somewhere else.")
        return {"kind": "create", "path": self.rel(p), "before": None, "after": content.rstrip("\n") + "\n", "summary": f"Create {self.rel(p)}"}

    def plan_edit(self, path, old_text, new_text):
        p = self.note(path)
        if not p.is_file():
            raise ToolError(f"Note not found: {path}")
        text = self.read(p)
        if not old_text:
            raise ToolError("old_text is empty. Copy the exact passage to replace from read_note.")
        n = text.count(old_text)
        if n == 0:
            raise ToolError("old_text was not found exactly. Call read_note again and copy the passage character for character.")
        if n > 1:
            raise ToolError(f"old_text appears {n} times. Include more surrounding lines so it matches exactly once.")
        i = text.index(old_text)
        reg = self._region(text)
        if reg and i < reg[1] and i + len(old_text) > reg[0]:
            raise ToolError("That passage is inside the tracker's generated block, which is rewritten on every save. Edit outside it, or change the data in the app.")
        return {"kind": "edit", "path": self.rel(p), "before": text, "after": text[:i] + new_text + text[i + len(old_text):], "summary": f"Edit {self.rel(p)}"}

    def plan_append(self, path, text, under_heading=None):
        p = self.note(path)
        if not p.is_file():
            raise ToolError(f"Note not found: {path}. Use create_note for a new note.")
        cur = self.read(p)
        add = text.strip("\n")
        if not under_heading:
            after = cur.rstrip("\n") + ("\n\n" if cur.strip() else "") + add + "\n"
            return {"kind": "edit", "path": self.rel(p), "before": cur, "after": after, "summary": f"Append to {self.rel(p)}"}
        lines, fence, at, level = cur.split("\n"), False, None, 0
        want = under_heading.strip().lstrip("#").strip().lower()
        for i, line in enumerate(lines):
            if re.match(r"^\s*(```|~~~)", line):
                fence = not fence
            m = None if fence else re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", line)
            if not m:
                continue
            if at is None and m.group(2).strip().lower() == want:
                at, level = i, len(m.group(1))
            elif at is not None and len(m.group(1)) <= level:
                end = i
                break
        else:
            end = len(lines)
        if at is None:
            raise ToolError(f"No heading '{under_heading}' in {self.rel(p)}. Use read_note to check the headings, or append without under_heading.")
        while end > at + 1 and not lines[end - 1].strip():
            end -= 1
        pos = len("\n".join(lines[:end]))
        reg = self._region(cur)
        if reg and reg[0] <= pos <= reg[1]:
            raise ToolError("That heading is inside the tracker's generated block. Append to a section outside it.")
        after = "\n".join(lines[:end]) + "\n" + add + "\n" + ("\n" if end < len(lines) else "") + "\n".join(lines[end:]).lstrip("\n")
        return {"kind": "edit", "path": self.rel(p), "before": cur, "after": after.rstrip("\n") + "\n", "summary": f"Add under “{under_heading}” in {self.rel(p)}"}

    def plan_move(self, from_path, to_path):
        src, dst = self.note(from_path), self.note(to_path)
        if not src.is_file():
            raise ToolError(f"Note not found: {from_path}")
        if dst.exists():
            raise ToolError(f"{self.rel(dst)} already exists. Pick another name; notes are never overwritten.")
        if self.is_tracker(src) or self.is_tracker(dst):
            raise ToolError(f"Notes in '{self.tracker}' are managed by the tracker and can't be moved there or out.")
        return {"kind": "move", "path": self.rel(src), "to": self.rel(dst), "summary": f"Move {self.rel(src)} → {self.rel(dst)}"}

    @staticmethod
    def diff(plan):
        if plan["kind"] in ("move", "moves"):
            return ""
        a = (plan["before"] or "").splitlines()
        b = plan["after"].splitlines()
        return "\n".join(difflib.unified_diff(a, b, "before", "after", n=2, lineterm=""))

    def preview(self, plan):
        if plan["kind"] == "moves":
            return {"kind": "moves", "path": "", "summary": plan["summary"], "diff": "", "moves": plan["moves"]}
        out = {"kind": plan["kind"], "path": plan["path"], "summary": plan["summary"], "diff": self.diff(plan)}
        if plan["kind"] == "move":
            out["to"] = plan["to"]
            out["backlinks"] = self.backlinks(plan["path"])
        return out

    def backlinks(self, rel_path):
        name = Path(rel_path).stem
        pat = re.compile(r"\[\[(" + re.escape(name) + "|" + re.escape(rel_path[:-3]) + r")(#[^\]|]*)?(\|[^\]]*)?\]\]", re.I)
        hits = []
        for rp in vault_paths(self.root, self.root):
            if rp != rel_path and pat.search(self.read(self.root / rp)):
                hits.append(rp)
        return hits[:50]

    def apply(self, plan, label):
        uid = time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3)
        if plan["kind"] == "moves":
            return self._apply_moves(plan, label, uid)
        if plan["kind"] == "move":
            src, dst = self.root / plan["path"], self.root / plan["to"]
            links = self.backlinks(plan["path"])
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.rename(src, dst)
            paths = [plan["path"], plan["to"]]
            record = {"kind": "move", "from": plan["path"], "to": plan["to"]}
        else:
            p = self.root / plan["path"]
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".nwa-tmp")
            tmp.write_text(plan["after"], encoding="utf-8")
            os.replace(tmp, p)
            paths, links = [plan["path"]], []
            record = {"kind": plan["kind"], "path": plan["path"], "before": plan["before"], "after": plan["after"]}
        commit = git_commit(self.root, paths, f"Assistant: {label or plan['summary']}") if self.git_on else None
        self._save_undo(uid, {**record, "summary": plan["summary"], "at": time.time()})
        return {"undoId": uid, "commit": commit, "backlinks": links, "paths": paths}

    def _apply_moves(self, plan, label, uid):
        done, failed = [], []
        for m in plan["moves"]:
            src, dst = self.root / m["from"], self.root / m["to"]
            try:
                if dst.exists():
                    raise OSError("something with that name is already there")
                dst.parent.mkdir(parents=True, exist_ok=True)
                os.rename(src, dst)
                done.append([m["from"], m["to"]])
            except OSError as e:
                failed.append({"from": m["from"], "to": m["to"], "error": str(e)})
        commit = git_commit_moves(self.root, done, f"Assistant: {label or plan['summary']}") if self.git_on and done else None
        if done:
            self._save_undo(uid, {"kind": "moves", "moves": done, "summary": plan["summary"], "at": time.time()})
        return {"undoId": uid if done else None, "commit": commit, "backlinks": [], "paths": [p for pair in done for p in pair], "moved": done, "failed": failed}

    # ----- undo -----
    def _save_undo(self, uid, rec):
        self.undo_dir.mkdir(parents=True, exist_ok=True)
        (self.undo_dir / f"{uid}.json").write_text(json.dumps(rec), encoding="utf-8")
        old = sorted(self.undo_dir.glob("*.json"))[:-UNDO_KEEP]
        for f in old:
            f.unlink(missing_ok=True)

    def undo(self, uid):
        if not re.fullmatch(r"[\w-]{6,40}", uid or ""):
            raise ToolError("Bad undo id")
        f = self.undo_dir / f"{uid}.json"
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise ToolError("That change can no longer be undone here (use git history instead).")
        if rec.get("undone"):
            raise ToolError("Already undone.")
        if rec["kind"] == "moves":
            back, stuck = [], []
            for frm, to in reversed(rec["moves"]):
                src, dst = self.root / to, self.root / frm
                if src.exists() and not dst.exists():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    os.rename(src, dst)
                    back.append([to, frm])
                else:
                    stuck.append(to)
            if not back:
                raise ToolError("Those files were moved or changed again since; nothing was undone.")
            commit = git_commit_moves(self.root, back, f"Undo assistant: {rec.get('summary', '')}") if self.git_on else None
            rec["undone"] = True
            f.write_text(json.dumps(rec), encoding="utf-8")
            return {"commit": commit, "paths": [p for pair in back for p in pair], "stuck": stuck}
        if rec["kind"] == "move":
            src, dst = self.root / rec["to"], self.root / rec["from"]
            if not src.exists() or dst.exists():
                raise ToolError("The note was moved or renamed again since; undo it with git instead.")
            os.rename(src, dst)
            paths = [rec["to"], rec["from"]]
        else:
            p = self.root / rec["path"]
            if not p.exists() or self.read(p) != rec["after"]:
                raise ToolError("The note changed after this edit; undo it with git history instead so nothing is lost.")
            if rec["before"] is None:  # undoing a create: park it in .trash (never deleted)
                trash = self.root / ".trash"
                trash.mkdir(exist_ok=True)
                target = trash / p.name
                if target.exists():
                    target = trash / f"{p.stem} {time.strftime('%Y%m%d-%H%M%S')}{p.suffix}"
                os.replace(p, target)
            else:
                p.write_text(rec["before"], encoding="utf-8")
            paths = [rec["path"]]
        commit = git_commit(self.root, paths, f"Undo assistant: {rec.get('summary', '')}") if self.git_on else None
        rec["undone"] = True
        f.write_text(json.dumps(rec), encoding="utf-8")
        return {"commit": commit, "paths": paths}


# ---------- Markdown section helpers (quick capture) ----------
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")


def _headings(lines):
    """(index, level, text) for each Markdown heading outside code fences."""
    out, fence = [], False
    for i, line in enumerate(lines):
        if FENCE_RE.match(line):
            fence = not fence
            continue
        m = None if fence else HEADING_RE.match(line)
        if m:
            out.append((i, len(m.group(1)), m.group(2).strip()))
    return out


def ensure_heading(text, heading, newest_first=True, level=2):
    """Return `text` with a `## heading` section, adding it if missing. With newest_first the new
    section goes above the first existing section of that level (below any title/front matter)."""
    lines = text.split("\n")
    hs = _headings(lines)
    if any(h[2].lower() == heading.lower() for h in hs):
        return text
    block = ["#" * level + " " + heading, ""]
    first = next((i for i, lvl, _ in hs if lvl == level), None)
    if newest_first and first is not None:
        return "\n".join(lines[:first] + block + lines[first:])
    body = text.rstrip("\n")
    return (body + "\n\n" if body.strip() else "") + "\n".join(block) + "\n"


def append_under_heading(text, heading, line):
    """Add `line` at the end of the section under `heading` (which must exist)."""
    lines = text.split("\n")
    hs = _headings(lines)
    at = next((k for k, h in enumerate(hs) if h[2].lower() == heading.lower()), None)
    if at is None:
        raise ToolError(f"No heading '{heading}'")
    start, level = hs[at][0], hs[at][1]
    end = next((i for i, lvl, _ in hs[at + 1:] if lvl <= level), len(lines))
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1
    rest = lines[end:]
    if any(x.strip() for x in rest):  # exactly one blank line before the next section
        while not rest[0].strip():
            rest.pop(0)
        rest = [""] + rest
    else:  # last section: end the file right after the new line
        rest = []
    out = lines[:end] + [line] + rest
    result = "\n".join(out)
    return result if result.endswith("\n") else result + "\n"


def vault_paths(base, root):
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for f in sorted(filenames):
            if f.endswith(".md") and not f.startswith("."):
                out.append((Path(dirpath) / f).relative_to(root).as_posix())
    return out
