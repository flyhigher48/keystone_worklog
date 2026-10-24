"""Safe file replacement on every OS.

On Windows a file can't be replaced while another program has it open – OneDrive syncing it, an antivirus
scan, the search indexer – and that shows up as "PermissionError: Access is denied". Those locks last a
moment, so writes here retry for a couple of seconds before giving up.
"""
import os
import threading
import time
from pathlib import Path

RETRY_SECONDS = 3.0


def replace(src, dst, retry=RETRY_SECONDS):
    """os.replace, retried while the destination (or source) is briefly locked by another program."""
    deadline, delay = time.monotonic() + retry, 0.02
    while True:
        try:
            return os.replace(src, dst)
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.25)


def write_text(path, text, retry=RETRY_SECONDS, mode=None):
    """Write `text` to `path` atomically: a temporary file next to it, then a (retried) replace."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    if mode is None:
        tmp.write_text(text, encoding="utf-8")
    else:  # e.g. 0o600 for files holding API keys
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
    try:
        replace(tmp, path, retry)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def in_cloud_folder(path):
    """True if `path` is inside a OneDrive / Dropbox / iCloud / Google Drive folder that syncs while files change."""
    p = str(Path(path).resolve()).lower().replace("\\", "/")
    for var in ("OneDrive", "OneDriveCommercial", "OneDriveConsumer"):
        base = os.environ.get(var)
        if base and p.startswith(str(Path(base).resolve()).lower().replace("\\", "/")):
            return True
    return any(part in p for part in ("/onedrive", "/dropbox/", "/icloud drive/", "/icloud~", "/google drive/", "/my drive/"))
