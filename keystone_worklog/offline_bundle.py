"""Prepare Keystone for a computer without internet.

Run on a computer WITH internet, then copy the output folder to the offline one:

    keystone-worklog-bundle                       # or: python -m keystone_worklog.offline_bundle
        models/   embedding model + browser runtime (~46 MB)
        wheels/   Keystone and every Python package it needs, for THIS kind of computer (~150 MB)

    keystone-worklog-bundle --platform win_amd64 --python-version 3.12    # packages for another target
    keystone-worklog-bundle --skip-wheels                                  # model only
    keystone-worklog-bundle --dest D:/keystone-offline                     # where to put it

On the offline computer:

    pip install --no-index --find-links wheels "keystone-worklog[all]"
    keystone-worklog --models-dir models --offline
"""
import argparse
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

from . import __version__
from .vector_index import EMBED_FILES, EMBED_SOURCES

PACKAGE = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE.parent
SOURCE_CHECKOUT = (PROJECT_ROOT / "pyproject.toml").is_file()


def model_cache():
    """Where a running Keystone keeps the files it already downloaded (reused instead of re-downloading)."""
    try:
        from .app import MODEL_CACHE
        return MODEL_CACHE
    except Exception:  # Flask not installed yet, etc.
        return None


def fetch_models(dest):
    total, cache = 0, model_cache()
    for kind, files in EMBED_FILES.items():
        for rel in files:
            out = dest / "models" / kind / rel
            cached = cache / kind / rel if cache else None
            out.parent.mkdir(parents=True, exist_ok=True)
            if out.is_file() and out.stat().st_size:
                print(f"  ok      {rel}")
            elif cached and cached.is_file() and cached.stat().st_size:
                shutil.copyfile(cached, out)
                print(f"  copied  {rel}")
            else:
                tmp = out.with_suffix(out.suffix + ".part")
                print(f"  fetch   {rel} …", end="", flush=True)
                with urllib.request.urlopen(EMBED_SOURCES[kind] + rel, timeout=300) as r, open(tmp, "wb") as f:
                    shutil.copyfileobj(r, f)
                tmp.replace(out)
                print(" done")
            total += out.stat().st_size
    print(f"Embedding model ready in {dest / 'models'} ({total / 1e6:.0f} MB)")


def fetch_wheels(dest, platforms, python_version):
    wheels = dest / "wheels"
    target = [arg for p in platforms or [] for arg in ("--platform", p)] + (["--python-version", python_version] if python_version else [])
    pip = [sys.executable, "-m", "pip"]
    if SOURCE_CHECKOUT:
        # Keystone itself is pure Python, so one wheel built here works everywhere
        print("Building the keystone-worklog wheel from this checkout…")
        subprocess.run([*pip, "wheel", "--no-deps", "-w", str(wheels), str(PROJECT_ROOT)], check=True)
        reqs = ["-r", str(PROJECT_ROOT / "requirements.txt")]
    else:
        reqs = [f"keystone-worklog[all]=={__version__}"]
    print("Downloading Python packages…")
    subprocess.run([*pip, "download", *reqs, "-d", str(wheels), "--only-binary=:all:", *target], check=True)
    files = list(wheels.glob("*.whl"))
    print(f"{len(files)} packages ready in {wheels} ({sum(f.stat().st_size for f in files) / 1e6:.0f} MB)")


def main():
    sys.stdout.reconfigure(line_buffering=True)  # keep our lines in order with pip's output
    ap = argparse.ArgumentParser(prog="keystone-worklog-bundle", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dest", type=Path, default=PROJECT_ROOT if SOURCE_CHECKOUT else Path("keystone-offline"), help="output folder")
    ap.add_argument("--skip-wheels", action="store_true", help="only bundle the embedding model")
    ap.add_argument("--platform", action="append", help="target platform tag, e.g. win_amd64, manylinux_2_28_x86_64, macosx_11_0_arm64 (repeatable)")
    ap.add_argument("--python-version", help="target Python version, e.g. 3.12 (default: this one)")
    args = ap.parse_args()
    dest = args.dest.resolve()
    print("Embedding model:")
    fetch_models(dest)
    if not args.skip_wheels:
        fetch_wheels(dest, args.platform, args.python_version)
    print(f"\nNow copy {dest / 'models'} and {dest / 'wheels'} to the offline computer and run:\n"
          '  pip install --no-index --find-links wheels "keystone-worklog[all]"\n'
          "  keystone-worklog --models-dir models --offline")


if __name__ == "__main__":
    main()
