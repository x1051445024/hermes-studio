#!/usr/bin/env python3
"""Deploy helper for the 0.7.18 + extra_headers build.

Usage:
  python deploy_0718_extra_headers.py backup     # back up current installed dist pieces
  python deploy_0718_extra_headers.py deploy     # copy built artifacts into the install dir
  python deploy_0718_extra_headers.py rollback   # restore from the newest backup
  python deploy_0718_extra_headers.py status     # show current state

Backups land in: <BACKUPS_ROOT>\<stamp>_extra-headers-codex
"""
import json
import os
import shutil
import sys
import time
from pathlib import Path

# Paths are placeholders. Override with environment variables on your machine:
#   HERMES_INSTALL_DIR, HERMES_BUILD_DIR, HERMES_BACKUPS_ROOT
INSTALL = Path(os.environ.get("HERMES_INSTALL_DIR", r"C:\Program Files\Hermes Studio\resources\webui\dist"))
BUILD = Path(os.environ.get("HERMES_BUILD_DIR", r"<SOURCE_COPY>\dist"))
BACKUPS_ROOT = Path(os.environ.get("HERMES_BACKUPS_ROOT", r"<BACKUPS_DIR>"))
TAG = "_extra-headers-codex"

FILES = [
    # (install-relative path, build-relative path) — single files to replace
    ("server/index.js", "server/index.js"),
]
DIRS = [
    # (install-relative dir, build-relative dir) — whole directories to replace
    ("client", "client"),
]


def newest_backup() -> Path | None:
    if not BACKUPS_ROOT.is_dir():
        return None
    cands = sorted(p for p in BACKUPS_ROOT.iterdir() if p.is_dir() and p.name.endswith(TAG))
    return cands[-1] if cands else None


def backup() -> None:
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dest = BACKUPS_ROOT / f"{stamp}{TAG}"
    dest.mkdir(parents=True, exist_ok=True)
    for rel, _ in FILES:
        src = INSTALL / rel
        if src.exists():
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, out)
            print(f"backed up file: {rel} ({out.stat().st_size:,} bytes)")
    for rel, _ in DIRS:
        src = INSTALL / rel
        if src.is_dir():
            shutil.copytree(src, dest / rel)
            count = sum(1 for _ in (dest / rel).rglob("*") if _.is_file())
            print(f"backed up dir: {rel} ({count} files)")
    (dest / "MANIFEST.txt").write_text(
        "Backup of installed Hermes Studio dist pieces before deploying the "
        "0.7.18 + extra_headers build.\n"
        f"stamp: {stamp}\n"
        "restore: run deploy script with 'rollback' or copy back manually.\n",
        encoding="utf-8",
    )
    print("backup dir:", dest)


def deploy() -> None:
    if not (BUILD / "server" / "index.js").exists():
        sys.exit("build missing: " + str(BUILD / "server" / "index.js"))
    bk = newest_backup()
    if bk is None:
        sys.exit("no backup found; run 'backup' first")
    for rel, brel in FILES:
        src = BUILD / brel
        if not src.exists():
            sys.exit(f"build artifact missing: {src}")
        shutil.copy2(src, INSTALL / rel)
        print(f"deployed file: {rel} ({src.stat().st_size:,} bytes)")
    for rel, brel in DIRS:
        src = BUILD / brel
        if not src.is_dir():
            sys.exit(f"build dir missing: {src}")
        dst = INSTALL / rel
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        count = sum(1 for _ in dst.rglob("*") if _.is_file())
        print(f"deployed dir: {rel} ({count} files)")
    print("deploy complete. Restart Hermes Studio to load the new server.")


def rollback() -> None:
    bk = newest_backup()
    if bk is None:
        sys.exit("no backup found")
    print("rolling back from:", bk)
    for rel, _ in FILES:
        src = bk / rel
        if src.exists():
            shutil.copy2(src, INSTALL / rel)
            print(f"restored file: {rel}")
    for rel, _ in DIRS:
        src = bk / rel
        if src.is_dir():
            dst = INSTALL / rel
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
            print(f"restored dir: {rel}")
    print("rollback complete. Restart Hermes Studio.")


def status() -> None:
    print("install dir:", INSTALL)
    for rel, _ in FILES:
        p = INSTALL / rel
        print(" ", rel, p.stat().st_size if p.exists() else "MISSING")
    bk = newest_backup()
    print("newest backup:", bk)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    {"backup": backup, "deploy": deploy, "rollback": rollback, "status": status}[cmd]()
