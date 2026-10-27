"""Keystone web server. Start it with `keystone-worklog` (or `python app.py` in a source checkout)."""
import hashlib
import json
import os
import re
import sys
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from flask import Flask, Response, abort, jsonify, request, send_file, send_from_directory, stream_with_context
from werkzeug.exceptions import HTTPException

from . import __version__, assistant, costs, documents, fsutil, msproject, vault, vector_index

BASE = Path(__file__).resolve().parent      # the package: static/ lives here
PROJECT_ROOT = BASE.parent                   # the repository, when running from a source checkout


def default_data_dir():
    """./data in a source checkout (where it always was); otherwise the usual per-user app-data folder."""
    if (PROJECT_ROOT / "pyproject.toml").is_file() or (PROJECT_ROOT / "data").is_dir():
        return PROJECT_ROOT / "data"
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "keystone-worklog"


DATA_DIR = Path(os.environ.get("KEYSTONE_DATA_DIR") or default_data_dir())  # override for tests or a second profile
DATA_FILE = DATA_DIR / "data.json"
MANIFEST = DATA_DIR / "vault_manifest.json"
BACKUP_DIR = DATA_DIR / "backups"           # one dated copy per day (last 60 kept)
BACKUP_NAME = re.compile(r"^data-(\d{4}-\d{2}-\d{2})\.json$")
PORT = int(os.environ.get("KEYSTONE_PORT") or 5000)
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
# "Open in app" never launches these, even when they're readable text (on Windows, opening a script runs it)
NO_LAUNCH = {".py", ".pyw", ".sh", ".bash", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".com", ".exe", ".msi", ".jar", ".scr",
             ".pl", ".rb", ".command", ".app", ".desktop", ".lnk", ".url", ".reg", ".hta", ".cpl", ".ipynb"}
OFFLINE = os.environ.get("KEYSTONE_OFFLINE", "").lower() in ("1", "true", "yes")  # never download anything
SLOW_REQUEST = float(os.environ.get("KEYSTONE_SLOW_LOG") or 2.0)  # log requests slower than this (seconds) to the console
MAX_UPLOAD = 25 * 1024 * 1024
LOCK = threading.Lock()

app = Flask(__name__, static_folder=str(BASE / "static"), static_url_path="/static")


@app.before_request
def local_only():
    # the app can read and write files in your vault, so only answer this machine
    if (request.host or "").rsplit(":", 1)[0] not in ("127.0.0.1", "localhost"):
        abort(403, "Keystone only accepts requests from this computer.")
    request.started = time.monotonic()


@app.after_request
def isolate_and_time(r):
    # cross-origin isolation lets the in-browser embedding model use several CPU threads (everything is served from here)
    r.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    r.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    r.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    if request.method != "GET" and r.status_code < 400 and request.path.startswith(("/api/notes", "/api/files", "/api/assistant/tool", "/api/assistant/undo")):
        documents.invalidate()  # a file was written, moved or removed: rescan on the next look
    took = time.monotonic() - getattr(request, "started", time.monotonic())
    if took > SLOW_REQUEST:
        print(f"[keystone] slow request: {request.method} {request.path} took {took:.1f} s", flush=True)
    return r


@app.errorhandler(HTTPException)
def json_errors(e):
    if request.path.startswith("/api/"):
        return jsonify(error=e.description), e.code
    return e


@app.errorhandler(Exception)
def unexpected_errors(e):
    """Anything unexpected: the full story in the console, and a readable message for the page (not just "500")."""
    import traceback
    print(f"[keystone] error in {request.method} {request.path}:\n" + "".join(traceback.format_exception(e)), flush=True)
    msg = f"{type(e).__name__}: {e}"
    if isinstance(e, PermissionError):
        msg += " – another program has this file open (antivirus, backup or sync tool, or a second copy of Keystone)."
    return (jsonify(error=msg), 500) if request.path.startswith("/api/") else (msg, 500)


# ---------- tracker data ----------
def load_data():
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    return {}


def save_data(payload):
    DATA_DIR.mkdir(exist_ok=True)
    if DATA_FILE.exists():  # keep one previous copy as a safety net
        try:
            shutil.copyfile(DATA_FILE, DATA_DIR / "data.json.bak")
        except OSError:
            pass  # the backup is a nicety; never fail a save over it
    fsutil.write_text(DATA_FILE, json.dumps(payload, indent=2))
    daily_snapshot(payload)


def daily_snapshot(payload):
    """A dated backup per day, plus (if enabled in Settings) one git commit of data.json per day."""
    today = time.strftime("%Y-%m-%d")
    try:
        BACKUP_DIR.mkdir(exist_ok=True)
        dest = BACKUP_DIR / f"data-{today}.json"
        shutil.copyfile(DATA_FILE, dest)  # refreshed through the day; yesterday's copy stays as it was
        for old in sorted(BACKUP_DIR.glob("data-*.json"))[:-60]:
            old.unlink(missing_ok=True)
        backup_costs(today)
        marker = BACKUP_DIR / ".git-day"
        if payload.get("settings", {}).get("dataGit") and (not marker.exists() or marker.read_text() != today) and ensure_data_repo():
            assistant.git_commit(DATA_DIR, ["data.json"], f"Keystone tracker data {today}")
            marker.write_text(today)
    except (OSError, subprocess.SubprocessError):
        pass  # a backup problem must never block saving


def backup_costs(today):
    """People, rates and cost ledgers: one dated folder per day (last 60 kept), next to the data.json backups."""
    files = ([PEOPLE_FILE] if PEOPLE_FILE.exists() else []) + (sorted(COSTS_DIR.glob("*.json")) if COSTS_DIR.is_dir() else [])
    if not files:
        return
    dest = BACKUP_DIR / f"costs-{today}"
    dest.mkdir(exist_ok=True)
    for f in files:
        shutil.copyfile(f, dest / f.name)
        os.chmod(dest / f.name, 0o600)
    for old in sorted(d for d in BACKUP_DIR.glob("costs-*") if d.is_dir())[:-60]:
        shutil.rmtree(old, ignore_errors=True)


def ensure_data_repo():
    """A private git repo inside data/ that tracks only data.json – separate from the code repository."""
    if (DATA_DIR / ".git").exists():
        return True
    if not shutil.which("git"):
        return False
    subprocess.run(["git", "init", "-q"], cwd=DATA_DIR, check=True, capture_output=True)
    (DATA_DIR / ".gitignore").write_text("*\n!data.json\n!.gitignore\n", encoding="utf-8")  # never API keys, chats or caches
    return True


def data_repo_status():
    if not (DATA_DIR / ".git").exists():
        return {"git": bool(shutil.which("git")), "repo": False}
    return assistant.git_status(DATA_DIR)


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/data")
def read_data():
    with LOCK:
        data = load_data()
        if data:
            changes, _ = vault.cycle(data, MANIFEST)
            if changes:
                save_data(data)
        return jsonify(data)


@app.put("/api/data")
def write_data():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        abort(400, "expected a JSON object")
    with LOCK:
        changes, info = vault.cycle(payload, MANIFEST)  # pull ticks from the vault first, then export
        save_data(payload)
    return jsonify(ok=True, synced=changes, data=payload if changes else None, vault=info)


@app.post("/api/vault/sync")
def vault_sync():
    with LOCK:
        data = load_data()
        changes, info = vault.cycle(data, MANIFEST) if data else (0, None)
        if changes:
            save_data(data)
    return jsonify(synced=changes, data=data if changes else None, vault=info)


@app.get("/api/vault/status")
def vault_status():
    path = load_data().get("settings", {}).get("vaultPath")
    if not path:
        return jsonify(path=None)
    root = Path(path).expanduser()
    try:
        files = json.loads(MANIFEST.read_text(encoding="utf-8")).get("projects", {})
    except (OSError, ValueError):
        files = {}
    return jsonify(path=path, ok=root.is_dir(), isObsidian=(root / ".obsidian").is_dir(), projectFiles=files)


# ---------- folder picker (lists folder names only) ----------
@app.get("/api/fs/browse")
def browse():
    p = Path(request.args.get("path") or Path.home()).expanduser()
    try:
        p = p.resolve()
        if not p.is_dir():
            abort(400, f"Not a folder: {p}")
        dirs = []
        for c in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if c.name.startswith(".") or not c.is_dir():
                continue
            dirs.append({"name": c.name, "path": str(c), "isVault": (c / ".obsidian").is_dir()})
            if len(dirs) >= 500:
                break
    except PermissionError:
        abort(403, f"No permission to open {p}")
    return jsonify(path=str(p), parent=str(p.parent) if p.parent != p else None, home=str(Path.home()),
                   isVault=(p / ".obsidian").is_dir(), dirs=dirs)


# ---------- notes: every path is relative to, and locked inside, the vault ----------
def vault_root():
    path = load_data().get("settings", {}).get("vaultPath")
    if not path:
        abort(400, "No vault selected. Choose one in Settings.")
    root = Path(path).expanduser().resolve()
    if not root.is_dir():
        abort(400, f"Vault folder not found: {root}")
    return root


def safe_path(rel, md=True):
    """Resolve a vault-relative path; md=True only allows .md, "file" allows notes or images, False allows anything."""
    if not rel or "\x00" in rel or Path(rel).is_absolute():
        abort(400, "Bad path")
    if any(part.startswith(".") for part in Path(rel).parts):
        abort(400, "Hidden files and folders are off limits")
    root = vault_root()
    p = (root / rel).resolve()
    if root not in p.parents:
        abort(400, "Path is outside the vault")
    ext = p.suffix.lower()
    if md is True and ext != ".md":
        abort(400, "Only .md notes can be edited")
    if md == "file" and ext != ".md" and ext not in IMAGE_TYPES:
        abort(400, "Only notes and images are allowed")
    return root, p


def mtime(p):
    return str(p.stat().st_mtime_ns)


@app.get("/api/notes/tree")
def notes_tree():
    """Every folder, note, image and document – decided by name and directory metadata only, never by opening
    a file (that is what made big vaults slow, and it would download OneDrive "online-only" files)."""
    root = vault_root()
    known = INDEX.known_files(root) if INDEX else {}  # files of unknown type are listed once indexing confirmed they're text
    items, stack = [], [(root, Path("."))]
    while stack and len(items) <= 20000:
        d, rel = stack.pop()
        try:
            entries = sorted(os.scandir(d), key=lambda e: e.name.lower())
        except OSError:
            continue
        dirs = []
        for e in entries:
            name = e.name
            if name.startswith((".", "~$")):
                continue
            try:
                is_dir = e.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                if name not in documents.SKIP_DIRS:
                    dirs.append((Path(e.path), rel / name))
                continue
            ext = Path(name).suffix.lower()
            path = (rel / name).as_posix()
            if ext == ".md":
                kind = "note"
            elif ext in IMAGE_TYPES:
                kind = "image"
            elif ext in documents.TYPES or ext in documents.TEXT_TYPES or ext in documents.LEGACY or ext == ".msg":
                kind = "doc"
            elif documents.candidate_kind(name) and not (known.get(path) or {}).get("skip") and path in known:
                kind = "doc"
            else:
                continue
            item = {"path": path, "type": kind}
            if kind != "image":
                try:
                    st = e.stat()  # from the directory listing on Windows
                    item["mtime"] = int(st.st_mtime)
                    if kind == "doc":
                        item["size"], item["kind"] = st.st_size, documents.kind(name)
                        if documents.is_cloud_only(st):
                            item["cloud"] = True
                        if ext in NO_LAUNCH:
                            item["script"] = True
                except OSError:
                    pass
            items.append(item)
        for full, r in reversed(dirs):
            items.append({"path": r.as_posix(), "type": "dir"})
            stack.append((full, r))
    items.sort(key=lambda i: i["path"].lower())
    return jsonify(root=str(root), name=root.name, items=items)


@app.get("/api/notes/file")
def note_read():
    _, p = safe_path(request.args.get("path"))
    if not p.is_file():
        abort(404, "Note not found")
    return jsonify(content=p.read_text(encoding="utf-8"), mtime=mtime(p))


@app.put("/api/notes/file")
def note_write():
    body = request.get_json(silent=True) or {}
    _, p = safe_path(body.get("path"))
    base, content = body.get("base"), body.get("content")
    if not isinstance(content, str):
        abort(400, "content must be text")
    with LOCK:
        if p.exists():
            if base is None:
                abort(409, "A note with that name already exists")
            if mtime(p) != base:  # changed elsewhere (e.g. Obsidian) since it was opened
                return jsonify(conflict=True, content=p.read_text(encoding="utf-8"), mtime=mtime(p)), 409
        fsutil.write_text(p, content)
    return jsonify(ok=True, mtime=mtime(p))


@app.post("/api/notes/rename")
def note_rename():
    """Rename/move a note, an image, or (with "folder": true) a folder."""
    body = request.get_json(silent=True) or {}
    kind = False if body.get("folder") else "file"
    root, src = safe_path(body.get("from"), md=kind)
    _, dst = safe_path(body.get("to"), md=kind)
    if not (src.is_dir() if kind is False else src.is_file()):
        abort(404, "Not found")
    if kind and (src.suffix.lower() == ".md") != (dst.suffix.lower() == ".md"):
        abort(400, "Keep the file type when renaming")
    if dst.exists():
        abort(409, "A note with that name already exists")
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.rename(src, dst)
    return jsonify(ok=True, path=dst.relative_to(root).as_posix())


@app.post("/api/notes/delete")
def note_delete():
    """Moves a note or image to the vault's .trash folder (same place Obsidian uses)."""
    body = request.get_json(silent=True) or {}
    root, p = safe_path(body.get("path"), md="file")
    if not p.is_file():
        abort(404, "Note not found")
    trash = root / ".trash"
    trash.mkdir(exist_ok=True)
    dst = trash / p.name
    if dst.exists():
        dst = trash / f"{p.stem} {time.strftime('%Y%m%d-%H%M%S')}{p.suffix}"
    os.replace(p, dst)
    return jsonify(ok=True)


@app.post("/api/notes/folder")
def note_folder():
    body = request.get_json(silent=True) or {}
    _, p = safe_path(body.get("path"), md=False)
    p.mkdir(parents=True, exist_ok=True)
    return jsonify(ok=True)


def obsidian_setting(root, name, key):
    try:
        return json.loads((root / ".obsidian" / name).read_text(encoding="utf-8")).get(key)
    except (OSError, ValueError, AttributeError):
        return None


def templates_folder(root):
    override = (load_data().get("settings", {}).get("templatesFolder") or "").strip().strip("/")
    return override or (obsidian_setting(root, "templates.json", "folder") or "Templates").strip().strip("/")


@app.get("/api/notes/config")
def notes_config():
    """Templates folder and attachment folder, taken from Obsidian's own settings when present."""
    root = vault_root()
    override = (load_data().get("settings", {}).get("templatesFolder") or "").strip().strip("/")
    folder = templates_folder(root)
    templates = []
    tdir = (root / folder).resolve()
    if root in tdir.parents and tdir.is_dir():
        for f in sorted(tdir.rglob("*.md"), key=lambda f: f.as_posix().lower()):
            if not any(part.startswith(".") for part in f.relative_to(root).parts):
                templates.append({"path": f.relative_to(root).as_posix(), "name": f.stem})
    return jsonify(templatesFolder=folder, templatesFromObsidian=not override and obsidian_setting(root, "templates.json", "folder") is not None,
                   templates=templates, attachmentFolder=obsidian_setting(root, "app.json", "attachmentFolderPath") or "/",
                   dateFormat=obsidian_setting(root, "templates.json", "dateFormat") or "YYYY-MM-DD",
                   timeFormat=obsidian_setting(root, "templates.json", "timeFormat") or "HH:mm")


@app.post("/api/notes/capture")
def note_capture():
    """Quick capture into one running note (Today.md): one `## heading` per day, newest day first by default.
    Creates the note and today's heading when needed, then adds `line` at the end of that day's section."""
    body = json_body()
    root, p = safe_path(body.get("path"))
    line = str(body.get("line") or "").rstrip()
    heading = str(body.get("heading") or "").strip().lstrip("#").strip()
    if not heading:
        abort(400, "heading is required")
    with LOCK:
        created = not p.exists()
        if created:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(str(body.get("template") or "").rstrip("\n") + "\n", encoding="utf-8")
        text = p.read_text(encoding="utf-8")
        new = assistant.ensure_heading(text, heading, newest_first=body.get("newestFirst", True) is not False)
        if line:
            new = assistant.append_under_heading(new, heading, line)
        if new != text:
            fsutil.write_text(p, new)
    return jsonify(ok=True, created=created, path=p.relative_to(root).as_posix(), mtime=mtime(p))


@app.post("/api/notes/upload")
def note_upload():
    """Save a pasted/dropped image. Body is the raw image; never overwrites (adds " 1", " 2"...)."""
    if not (request.content_type or "").startswith("image/"):
        abort(415, "Only images can be uploaded")
    data = request.get_data(cache=False)
    if not data or len(data) > MAX_UPLOAD:
        abort(413, "Image is empty or larger than 25 MB")
    root, p = safe_path(request.args.get("path"), md=False)
    if p.suffix.lower() not in IMAGE_TYPES:
        abort(400, "Unsupported image type")
    with LOCK:
        stem, n = p.stem, 1
        while p.exists():
            p = p.with_name(f"{stem} {n}{p.suffix}")
            n += 1
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return jsonify(ok=True, path=p.relative_to(root).as_posix())


@app.get("/api/notes/raw")
def note_raw():
    _, p = safe_path(request.args.get("path"), md=False)
    if p.suffix.lower() not in IMAGE_TYPES or not p.is_file():
        abort(404)
    return send_file(p)


# ---------- documents in the vault: preview text, view PDFs, open with this computer's apps ----------
def doc_path(rel):
    root, p = safe_path(rel, md=False)
    if not p.is_file() or not documents.listable(p):
        abort(404, "Document not found")
    return root, p


@app.get("/api/files/raw")
def file_raw():
    """PDFs open in the browser's own viewer; everything else is a download (never rendered on this site)."""
    _, p = doc_path(request.args.get("path"))
    pdf = p.suffix.lower() == ".pdf"
    r = send_file(p, mimetype="application/pdf" if pdf else None, as_attachment=not pdf, download_name=p.name, conditional=True)
    r.headers["X-Content-Type-Options"] = "nosniff"
    return r


@app.get("/api/files/text")
def file_text():
    root, p = doc_path(request.args.get("path"))
    if not documents.is_document(p):
        return jsonify(kind=documents.kind(p), sections=[], error=f"{p.suffix} files can't be read here – open it with its app.")
    e = TEXTS.get(root, p.relative_to(root).as_posix())
    return jsonify(kind=documents.kind(p), sections=e["sections"][:400], more=max(0, len(e["sections"]) - 400), error=e["error"])


def open_with_system(p, reveal=False):
    """Open a file with its default app, or show it in the file manager. Runs on this computer only."""
    if sys.platform.startswith("win"):
        if reveal:
            subprocess.Popen(["explorer", "/select,", str(p)])
        else:
            os.startfile(str(p))  # noqa: S606 – a vault document, type-checked by the caller
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(p)] if reveal else ["open", str(p)])
    else:
        subprocess.Popen(["xdg-open", str(p.parent if reveal else p)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


@app.post("/api/files/open")
def file_open():
    body = json_body()
    rel = body.get("path")
    root, p = safe_path(rel, md=False)
    ext = p.suffix.lower()
    reveal = bool(body.get("reveal"))
    if not p.is_file() or not (ext == ".md" or ext in IMAGE_TYPES or documents.listable(p)):
        abort(400, "Only notes, images and documents can be opened")
    if ext in NO_LAUNCH and not reveal:  # never run programs or scripts – showing them in the folder is fine
        abort(400, f"{p.name} is a script or program, so Keystone won't launch it. Use Show in folder, or view its text here.")
    try:
        open_with_system(p, reveal)
    except (OSError, FileNotFoundError) as e:
        abort(500, f"Couldn't open it on this computer: {e}")
    return jsonify(ok=True)


# ---------- AI assistant ----------
LLM_FILE = DATA_DIR / "llm.json"            # provider profiles incl. API keys (git-ignored, owner-only)
UNDO_DIR = DATA_DIR / "assistant_undo"
CHATS_DIR = DATA_DIR / "chats"
MODEL_CACHE = DATA_DIR / "models"           # embedding model + runtime, downloaded once
# The same files bundled for offline computers by offline_bundle.py: $KEYSTONE_MODELS_DIR, or models/ in a source checkout
MODEL_BUNDLE = Path(os.environ.get("KEYSTONE_MODELS_DIR") or PROJECT_ROOT / "models")
def index_dir():
    """Where the search index lives. It's a cache that is rewritten constantly while indexing, so it must not sit in a
    folder OneDrive / Dropbox syncs (they lock files mid-write, which Windows reports as "Access is denied"):
    $KEYSTONE_INDEX_DIR, else data/index – moved to the local, never-synced app-data folder when data/ is in such a folder."""
    if os.environ.get("KEYSTONE_INDEX_DIR"):
        return Path(os.environ["KEYSTONE_INDEX_DIR"])
    if fsutil.in_cloud_folder(DATA_DIR):
        local = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".cache") / "keystone-worklog"
        return local / ("index-" + hashlib.sha1(str(DATA_DIR.resolve()).encode()).hexdigest()[:10])
    return DATA_DIR / "index"


INDEX_DIR = index_dir()
INDEX = vector_index.VectorIndex(INDEX_DIR) if vector_index.available else None
TEXTS = INDEX.texts if INDEX else documents.TextCache(INDEX_DIR / "docs")  # extracted document text (works without LanceDB too)
WRITE_TOOLS = {"create_note", "edit_note", "append_to_note", "move_note", "move_files"}
CHAT_ID = re.compile(r"^[a-z0-9]{6,24}$")


def llm_settings():
    return assistant.load_settings(LLM_FILE)


def json_body():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        abort(400, "expected a JSON object")
    return body


@app.get("/api/assistant/settings")
def ai_settings_get():
    return jsonify({**assistant.public_settings(llm_settings()), "semanticAvailable": INDEX is not None, "offline": OFFLINE,
                    "documentTypes": sorted({documents.TYPES[e][0] for e in documents.supported()}), "documentsMissing": documents.missing()})


@app.put("/api/assistant/settings")
def ai_settings_put():
    body = json_body()
    with LOCK:
        assistant.save_settings(LLM_FILE, assistant.merge_settings(llm_settings(), body))
    return ai_settings_get()


def profile_from(body):
    """The saved profile, or unsaved edits from the settings form (key falls back to the saved one)."""
    s = llm_settings()
    p = body.get("profile")
    if isinstance(p, dict):
        saved = next((x for x in s["profiles"] if x["id"] == p.get("id")), {})
        return {**saved, **{k: v for k, v in p.items() if k in assistant.PROFILE_KEYS and k != "apiKey"},
                "baseUrl": (p.get("baseUrl") or "").strip().rstrip("/"), "apiKey": (p.get("apiKey") or "").strip() or saved.get("apiKey", "")}
    return assistant.get_profile(s, body.get("profileId") or s.get("active"))


@app.post("/api/assistant/models")
def ai_models():
    try:
        return jsonify(models=assistant.list_models(profile_from(json_body())))
    except (assistant.LLMError, ValueError) as e:
        abort(502, str(e))


@app.post("/api/assistant/test")
def ai_test():
    try:
        return jsonify(assistant.test_profile(profile_from(json_body())))
    except (assistant.LLMError, ValueError) as e:
        abort(502, str(e))


@app.post("/api/assistant/chat")
def ai_chat():
    body = json_body()
    if not isinstance(body.get("messages"), list):
        abort(400, "messages must be a list")
    try:
        prof = profile_from(body)
        stream = bool(body.get("stream", prof.get("stream", True)))
        resp = assistant.chat(prof, body["messages"], body.get("tools") or [], stream)
    except assistant.LLMError as e:
        abort(502, str(e))
    if not stream:
        with resp:
            return Response(resp.read(), mimetype="application/json")

    def relay():  # pass the provider's server-sent events straight through
        with resp:
            try:
                for line in resp:
                    yield line
            except OSError as e:
                yield ("data: " + json.dumps({"error": {"message": f"Stream interrupted: {e}"}}) + "\n\n").encode()
    return Response(stream_with_context(relay()), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def ai_tools():
    root = vault_root()

    def resolve(rel, md):  # vault-only paths; problems go back to the model as tool errors
        try:
            return safe_path(rel, md)
        except HTTPException as e:
            raise assistant.ToolError(e.description) from None
    settings = load_data().get("settings", {})
    folder = settings.get("vaultFolder") or vault.DEFAULT_FOLDER
    return assistant.Tools(root, resolve, vault.safe_folder(folder).as_posix(), UNDO_DIR, INDEX, llm_settings().get("gitCommit", True), TEXTS, docs_on(),
                           (settings.get("inboxFolder") or "Inbox").strip().strip("/"), (settings.get("captureNote") or "Today.md").strip())


def make_plan(t, name, a):
    if name == "create_note":
        return t.plan_create(a.get("path", ""), a.get("content", ""))
    if name == "edit_note":
        return t.plan_edit(a.get("path", ""), a.get("old_text", ""), a.get("new_text", ""))
    if name == "append_to_note":
        return t.plan_append(a.get("path", ""), a.get("text", ""), a.get("under_heading"))
    if name == "move_files":
        return t.plan_move_files(a.get("moves"))
    return t.plan_move(a.get("from_path", ""), a.get("to_path", ""))


@app.post("/api/assistant/tool")
def ai_tool():
    body = json_body()
    name, args, mode = body.get("name"), body.get("args") or {}, body.get("mode", "run")
    try:
        t = ai_tools()
        if name in WRITE_TOOLS:
            plan = make_plan(t, name, args)
            if mode == "preview":
                return jsonify(preview=t.preview(plan))
            if mode != "apply":
                abort(400, "mode must be preview or apply")
            if "previewDiff" in body and t.diff(plan) != body["previewDiff"]:
                raise assistant.ToolError("The note changed after the preview was shown, so nothing was applied. Read it again and propose the change again.")
            with LOCK:
                res = t.apply(plan, plan["summary"])
            msg = f"Done: {plan['summary']}." + (f" Git commit {res['commit']}." if res["commit"] else "")
            if plan["kind"] == "moves":
                msg = f"Moved {len(res['moved'])} file(s): " + "; ".join(f"{a} → {b}" for a, b in res["moved"][:60]) + "."
                if res["failed"]:
                    msg += " Not moved: " + "; ".join(f"{x['from']} ({x['error']})" for x in res["failed"]) + "."
            if res["backlinks"]:
                msg += " These notes link to the old name; update their links with edit_note if the user wants: " + ", ".join(res["backlinks"])
            return jsonify(result=msg, **res)
        if name == "search_notes":
            result = t.search_notes(args.get("query", ""), args.get("folder"), args.get("limit", 8), body.get("vector"))
        elif name == "read_note":
            result = t.read_note(args.get("path", ""), args.get("start_line"), args.get("end_line"))
        elif name == "read_document":
            result = t.read_document(args.get("path", ""), args.get("start_part"), args.get("end_part"))
        elif name == "vault_map":
            result = t.vault_map(args.get("folder") or "", args.get("depth") or 3)
        elif name == "suggest_folder":
            result = t.suggest_folder(args.get("path", ""), args.get("limit") or 3)
        elif name == "list_folder":
            result = t.list_folder(args.get("path") or "")
        elif name == "recent_notes":
            result = t.recent_notes(args.get("days", 7), args.get("limit", 30))
        elif name == "list_templates":
            result = t.list_templates(templates_folder(t.root))
        else:
            raise assistant.ToolError(f"Unknown tool: {name}")
        return jsonify(result=result)
    except assistant.ToolError as e:
        return jsonify(error=str(e))
    except (TypeError, ValueError) as e:
        return jsonify(error=f"Bad arguments for {name}: {e}")


# ---------- filing: the inbox review table (works without an AI model) ----------
@app.post("/api/inbox/suggest")
def inbox_suggest():
    body = json_body()
    try:
        t = ai_tools()
        return jsonify(t.inbox_suggestions(body.get("paths")))
    except assistant.ToolError as e:
        abort(400, str(e))


@app.post("/api/files/move")
def files_move():
    """Move files (any type) inside the vault: never overwrites, one undo for the batch, git commit where tracked."""
    body = json_body()
    try:
        t = ai_tools()
        plan = t.plan_move_files(body.get("moves"))
        with LOCK:
            res = t.apply(plan, body.get("label") or plan["summary"])
    except assistant.ToolError as e:
        abort(400, str(e))
    return jsonify(res)


# ---------- planner: one JSON file per plan in data/plans/ ----------
PLANS_DIR = DATA_DIR / "plans"
PLAN_ID = re.compile(r"^p_[a-f0-9]{8}$")


def plan_path(pid):
    if not PLAN_ID.match(pid or ""):
        abort(400, "Bad plan id")
    return PLANS_DIR / f"{pid}.json"


def read_plan(pid):
    p = plan_path(pid)
    plan = fsutil.read_json(p, default=None)
    if plan is None:
        abort(404, "Plan not found")
    return plan


def check_plan(plan):
    if not isinstance(plan, dict) or not isinstance(plan.get("tasks"), list):
        abort(400, "A plan needs a list of tasks")
    uids = [t.get("uid") for t in plan["tasks"] if isinstance(t, dict)]
    if len(uids) != len(plan["tasks"]) or len(set(uids)) != len(uids) or not all(isinstance(u, int) and u > 0 for u in uids):
        abort(400, "Every task needs a unique positive number (uid)")


@app.get("/api/plans")
def plans_list():
    out = []
    for f in sorted(PLANS_DIR.glob("p_*.json")) if PLANS_DIR.is_dir() else []:
        if not PLAN_ID.match(f.stem):  # skip the .bak.json copies
            continue
        try:
            j = fsutil.read_json(f, default=None) or {}
        except OSError:
            continue
        snaps = (fsutil.read_json(status_path(f.stem), default={}) or {}).get("snapshots") or []
        last = max(snaps, key=lambda x: x.get("date") or "", default=None)
        out.append({"id": j.get("id", f.stem), "name": j.get("name", ""), "projectId": j.get("projectId"), "tasks": len(j.get("tasks") or []),
                    "updated": j.get("updated"), "rev": j.get("rev", 0), "template": bool(j.get("template")),
                    "lastStatus": last and {"date": last.get("date"), "rag": (last.get("rag") or {}).get("overall")}})
    return jsonify(plans=sorted(out, key=lambda x: (x["name"] or "").lower()))


@app.post("/api/plans")
def plan_create():
    plan = json_body().get("plan")
    check_plan(plan)
    plan["id"], plan["rev"], plan["updated"] = "p_" + secrets.token_hex(4), 1, time.strftime("%Y-%m-%dT%H:%M:%S")
    fsutil.write_text(plan_path(plan["id"]), json.dumps(plan))
    return jsonify(plan)


@app.get("/api/plans/<pid>")
def plan_get(pid):
    return jsonify(read_plan(pid))


@app.put("/api/plans/<pid>")
def plan_save(pid):
    body = json_body()
    plan = body.get("plan")
    check_plan(plan)
    with LOCK:
        cur = read_plan(pid)
        if body.get("baseRev") is not None and body["baseRev"] != cur.get("rev"):
            return jsonify(error="This plan was changed somewhere else (another tab?) since you opened it.", plan=cur), 409
        try:
            shutil.copyfile(plan_path(pid), PLANS_DIR / f"{pid}.bak.json")  # one step back, just in case
        except OSError:
            pass
        plan.update(id=pid, rev=(cur.get("rev") or 0) + 1, updated=time.strftime("%Y-%m-%dT%H:%M:%S"))
        fsutil.write_text(plan_path(pid), json.dumps(plan))
    return jsonify(rev=plan["rev"], updated=plan["updated"])


@app.post("/api/plans/<pid>/delete")
def plan_delete(pid):
    p = plan_path(pid)
    if not p.exists():
        abort(404, "Plan not found")
    trash = PLANS_DIR / ".trash"
    trash.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    fsutil.replace(p, trash / f"{pid}-{stamp}.json")  # never deleted outright
    if status_path(pid).exists():
        fsutil.replace(status_path(pid), trash / f"{pid}-{stamp}.status.json")
    return jsonify(ok=True)


@app.post("/api/plans/import")
def plan_import():
    body = json_body()
    try:
        plan, warnings, stats = msproject.read_upload(body.get("filename") or "plan.xml", body.get("data") or "")
    except msproject.MSProjectError as e:
        abort(400, str(e))
    return jsonify(plan=plan, warnings=warnings, stats=stats)


@app.get("/api/plans/<pid>/export.xml")
def plan_export(pid):
    plan = read_plan(pid)
    xml = msproject.to_mspdi(plan)
    name = re.sub(r"[^\w\- .]+", "_", plan.get("name") or "plan").strip() or "plan"
    return Response(xml, mimetype="application/xml", headers={"Content-Disposition": f'attachment; filename="{name}.xml"'})


# ---------- status snapshots: data/plans/<id>.status.json ----------
def status_path(pid):
    plan_path(pid)  # validates the id
    return PLANS_DIR / f"{pid}.status.json"


@app.get("/api/plans/<pid>/status")
def plan_status(pid):
    doc = fsutil.read_json(status_path(pid), default=None) or {}
    return jsonify(snapshots=doc.get("snapshots") or [])


@app.put("/api/plans/<pid>/status")
def plan_status_save(pid):
    snap = json_body().get("snapshot")
    if not isinstance(snap, dict) or not re.match(r"^s_[\w-]{1,40}$", str(snap.get("id") or "")) or not re.match(r"^\d{4}-\d{2}-\d{2}$", str(snap.get("date") or "")):
        abort(400, "A snapshot needs an id (s_…) and a date")
    read_plan(pid)
    with LOCK:
        doc = fsutil.read_json(status_path(pid), default=None) or {}
        snaps = [x for x in doc.get("snapshots") or [] if x.get("id") != snap["id"]] + [snap]
        snaps.sort(key=lambda x: x.get("date") or "")
        fsutil.write_text(status_path(pid), json.dumps({**doc, "snapshots": snaps}), mode=costs.PRIVATE)
    return jsonify(ok=True, count=len(snaps))


@app.post("/api/plans/<pid>/status/remove")
def plan_status_remove(pid):
    """Take a snapshot out of the history (kept in the file's "removed" list – never deleted outright)."""
    sid = json_body().get("id")
    with LOCK:
        doc = fsutil.read_json(status_path(pid), default=None) or {}
        gone = [x for x in doc.get("snapshots") or [] if x.get("id") == sid]
        if not gone:
            abort(404, "No such snapshot")
        doc["snapshots"] = [x for x in doc.get("snapshots") or [] if x.get("id") != sid]
        doc["removed"] = (doc.get("removed") or []) + [{**gone[0], "removedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}]
        fsutil.write_text(status_path(pid), json.dumps(doc), mode=costs.PRIVATE)
    return jsonify(ok=True)


# ---------- people & rates (data/people.json) and the ERP cost ledgers (data/costs/) ----------
PEOPLE_FILE = DATA_DIR / "people.json"
COSTS_DIR = DATA_DIR / "costs"
LEDGERS = costs.Ledgers(COSTS_DIR)


@app.get("/api/people")
def people_get():
    doc = fsutil.read_json(PEOPLE_FILE, default=None)
    return jsonify(doc if isinstance(doc, dict) else {"rev": 0, "people": [], "rates": [], "costModels": [], "layouts": []})


@app.put("/api/people")
def people_save():
    body = json_body()
    doc = body.get("doc")
    if not isinstance(doc, dict) or not all(isinstance(doc.get(k, []), list) for k in ("people", "rates", "costModels", "layouts")):
        abort(400, "Expected people, rates, costModels and layouts lists")
    with LOCK:
        cur = fsutil.read_json(PEOPLE_FILE, default=None) or {}
        if body.get("baseRev") is not None and body["baseRev"] != cur.get("rev", 0):
            return jsonify(error="People & rates were changed somewhere else (another tab?).", doc=cur), 409
        if PEOPLE_FILE.exists():
            shutil.copyfile(PEOPLE_FILE, DATA_DIR / "people.json.bak")
            os.chmod(DATA_DIR / "people.json.bak", 0o600)
        doc["rev"] = (cur.get("rev") or 0) + 1
        fsutil.write_text(PEOPLE_FILE, json.dumps(doc, indent=1), mode=costs.PRIVATE)
    return jsonify(rev=doc["rev"])


def cost_call(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except costs.CostError as e:
        abort(400, str(e))


@app.post("/api/costs/parse")
def costs_parse():
    b = json_body()
    return jsonify(cost_call(costs.read_table, b.get("filename") or "", b.get("data"), b.get("text"), b.get("sheet")))


@app.get("/api/costs")
def costs_summary():
    return jsonify(projects=LEDGERS.summary())


@app.get("/api/costs/<pid>")
def costs_get(pid):
    return jsonify(cost_call(LEDGERS.load, pid))


@app.post("/api/costs/import")
def costs_import():
    b = json_body()
    groups = b.get("groups")
    if not isinstance(groups, list) or not groups:
        abort(400, "Nothing to import")
    out = []
    with LOCK:
        for g in groups:
            out.append({"projectId": g.get("projectId"), **cost_call(LEDGERS.import_batch, g.get("projectId"), g.get("covers"), g.get("lines"), b.get("source", ""), b.get("layout", ""))})
    return jsonify(batches=out)


@app.post("/api/costs/<pid>/undo")
def costs_undo(pid):
    with LOCK:
        return jsonify(cost_call(LEDGERS.undo, pid, json_body().get("batch")))


@app.post("/api/assistant/undo")
def ai_undo():
    try:
        with LOCK:
            return jsonify(ai_tools().undo(json_body().get("id", "")))
    except assistant.ToolError as e:
        abort(409, str(e))


@app.get("/api/backups")
def backups_list():
    out = []
    for f in sorted(BACKUP_DIR.glob("data-*.json"), reverse=True):
        m = BACKUP_NAME.match(f.name)
        if m:
            out.append({"name": f.name, "date": m.group(1), "size": f.stat().st_size})
    return jsonify(backups=out, git=data_repo_status())


@app.get("/api/backups/<name>")
def backup_read(name):
    if not BACKUP_NAME.match(name) or not (BACKUP_DIR / name).is_file():
        abort(404, "Backup not found")
    return jsonify(json.loads((BACKUP_DIR / name).read_text(encoding="utf-8")))


@app.get("/api/assistant/git")
def ai_git():
    return jsonify(assistant.git_status(vault_root()))


@app.post("/api/assistant/git/init")
def ai_git_init():
    try:
        return jsonify(assistant.git_init(vault_root()))
    except assistant.ToolError as e:
        abort(400, str(e))


# chat history (data/chats/<id>.json)
@app.get("/api/assistant/chats")
def ai_chats():
    out = []
    for f in sorted(CHATS_DIR.glob("*.json"), key=lambda f: -f.stat().st_mtime)[:50]:
        try:
            j = json.loads(f.read_text(encoding="utf-8"))
            out.append({"id": f.stem, "title": j.get("title") or "Untitled chat", "updated": f.stat().st_mtime})
        except (OSError, ValueError):
            pass
    return jsonify(chats=out)


@app.route("/api/assistant/chats/<cid>", methods=["GET", "PUT"])
def ai_chat_file(cid):
    if not CHAT_ID.match(cid):
        abort(400, "Bad chat id")
    f = CHATS_DIR / f"{cid}.json"
    if request.method == "GET":
        if not f.exists():
            abort(404, "Chat not found")
        return jsonify(json.loads(f.read_text(encoding="utf-8")))
    body = json_body()
    CHATS_DIR.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"title": str(body.get("title", ""))[:120], "items": body.get("items", []), "messages": body.get("messages", [])}), encoding="utf-8")
    for old in sorted(CHATS_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime)[:-100]:
        old.unlink(missing_ok=True)
    return jsonify(ok=True)


# semantic index (vectors come from the browser's embedding model)
def docs_on():
    s = llm_settings()
    documents.configure(s.get("plainText", True), s.get("indexExclude") or [], s.get("maxFileMB") or 100, s.get("includeCloud", False))
    return bool(s.get("documents", True))


@app.get("/api/index/status")
def index_status():
    if docs_on() and INDEX is None:
        try:
            TEXTS.warm(vault_root())  # no meaning index: extract document text in the background so keyword search covers documents
        except HTTPException:
            pass
    if INDEX is None:
        return jsonify(available=False)
    return jsonify(INDEX.status(vault_root(), request.args.get("model", ""), docs_on()))


@app.get("/api/index/files")
def index_files():
    """Per-file indexing status for Settings → Search index."""
    if INDEX is None:
        return jsonify(available=False, files=[], counts={}, total=0)
    a = request.args
    return jsonify(available=True, **INDEX.file_list(vault_root(), a.get("model", ""), docs_on(), a.get("filter") or "all", a.get("q") or "", int(a.get("limit") or 300)))


@app.post("/api/index/next")
def index_next():
    if INDEX is None:
        abort(400, "LanceDB is not installed")
    body = json_body()
    skip = body.get("skip") if isinstance(body.get("skip"), list) else []
    return jsonify(INDEX.next_batch(vault_root(), body.get("model", ""), max(1, min(16, int(body.get("limit") or 4))), docs_on(),
                                    skip[:5000], max(0, min(600, int(body.get("settle") or 0)))))


@app.post("/api/index/upsert")
def index_upsert():
    if INDEX is None:
        abort(400, "LanceDB is not installed")
    body = json_body()
    root, p = safe_path(body.get("path"), md=False)
    if p.suffix.lower() != ".md" and not documents.is_document(p):
        abort(400, "Only notes and documents are indexed")
    try:
        INDEX.upsert(root, body.get("model", ""), p.relative_to(root).as_posix(), int(body.get("mtime", 0)), body.get("chunks") or [], body.get("error"))
    except ValueError as e:
        abort(400, str(e))
    return jsonify(ok=True)


@app.post("/api/index/reset")
def index_reset():
    if INDEX is not None:
        INDEX.reset()
    return jsonify(ok=True)


# embedding model + runtime: bundled in ./models, or fetched once from Hugging Face / jsDelivr
def model_file(kind, p):
    if p not in vector_index.EMBED_FILES[kind]:  # only the known files: never an open proxy
        abort(404)
    dest = next((d for d in (MODEL_BUNDLE / kind / p, MODEL_CACHE / kind / p) if d.is_file()), None)
    if dest is None and OFFLINE:
        abort(404, "The embedding model isn't on this computer, and Keystone is running offline. "
                   "Run keystone-worklog-bundle on a computer with internet, copy its models/ folder here and start with --models-dir.")
    if dest is None:
        dest, url = MODEL_CACHE / kind / p, vector_index.EMBED_SOURCES[kind] + p
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f"{dest.name}.{secrets.token_hex(4)}.part")
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
            fsutil.replace(tmp, dest)
        except (urllib.error.URLError, OSError) as e:
            tmp.unlink(missing_ok=True)
            abort(502, f"The embedding model isn't on this computer and couldn't be downloaded ({e}). "
                       "Run keystone-worklog-bundle on a computer with internet, copy its models/ folder here and start with --models-dir.")
    types = {".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json"}
    return send_file(dest, mimetype=types.get(dest.suffix, "application/octet-stream"), max_age=30 * 86400)


@app.get("/hf/<path:p>")
def hf_files(p):
    return model_file("hf", p)


@app.get("/cdn/<path:p>")
def cdn_files(p):
    return model_file("cdn", p)


INSTANCE_FILE = DATA_DIR / "keystone.instance"


def running_instance():
    """The address of another Keystone using this data folder, if one is answering."""
    try:
        port = int(json.loads(INSTANCE_FILE.read_text(encoding="utf-8"))["port"])
        url = f"http://127.0.0.1:{port}"
        with urllib.request.urlopen(url + "/api/assistant/settings", timeout=2) as r:
            return url if r.status == 200 else None
    except Exception:
        return None


def claim_instance(port):
    try:
        fsutil.write_text(INSTANCE_FILE, json.dumps({"pid": os.getpid(), "port": port, "started": time.time()}))
    except OSError:
        return
    import atexit

    def release():
        try:
            if json.loads(INSTANCE_FILE.read_text(encoding="utf-8")).get("pid") == os.getpid():
                INSTANCE_FILE.unlink()
        except Exception:
            pass
    atexit.register(release)


def main():
    import argparse
    ap = argparse.ArgumentParser(prog="keystone-worklog", description="Keystone: time tracking, deliverables, notes and an AI assistant, on your own computer.")
    ap.add_argument("--port", type=int, default=PORT, help="port to listen on (default 5000, or $KEYSTONE_PORT)")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    ap.add_argument("--models-dir", type=Path, help="embedding model bundle made by keystone-worklog-bundle (for computers without internet)")
    ap.add_argument("--offline", action="store_true", help="never connect to the internet (for air-gapped computers; also $KEYSTONE_OFFLINE=1)")
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args = ap.parse_args()
    if args.offline:
        global OFFLINE
        OFFLINE = True
    if args.models_dir:
        global MODEL_BUNDLE
        MODEL_BUNDLE = args.models_dir.resolve()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    other = running_instance()
    if other:
        print(f"Keystone is already running with this data folder at {other} – open that, or stop it first.\n"
              f"Two copies writing the same files is what makes Windows report \"Access is denied\". "
              f"For a second, separate profile set KEYSTONE_DATA_DIR to another folder.")
        sys.exit(1)
    claim_instance(args.port)
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{args.port}")).start()
    print(f"Keystone is running at http://127.0.0.1:{args.port}  (data: {DATA_DIR})  Press Ctrl+C to stop.")
    if INDEX_DIR != DATA_DIR / "index":
        print(f"Search index: {INDEX_DIR}  (kept outside the synced data folder)")
    app.run(host="127.0.0.1", port=args.port)  # never expose this on a network: it reads and writes your vault


if __name__ == "__main__":
    main()
