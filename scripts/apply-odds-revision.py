#!/usr/bin/env python3
"""Apply only the reviewed odds revision; preserve all other working files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from datetime import datetime, timezone


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None


def atomic_copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    mode = target.stat().st_mode & 0o777 if target.exists() else 0o644
    fd, name = tempfile.mkstemp(prefix=".odds-revision-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(source.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, target)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True, type=Path)
    parser.add_argument("--android", required=True, type=Path)
    args = parser.parse_args()
    source_root = Path(__file__).resolve().parent.parent
    plan = json.loads((source_root / "docs/odds-contract/REVISION_DEPLOYMENT_PLAN.json").read_text())
    roots = {"backend": args.backend.resolve(), "android": args.android.resolve()}
    changes = []
    # Complete preflight before replacing any application file.
    for item in plan["files"]:
        root = roots[item["project"]]
        target = root / item["target"]
        if target.is_symlink() or not target.resolve().is_relative_to(root):
            raise RuntimeError("UNEXPECTED_TARGET_PATH: " + item["target"])
        source = source_root / item["source"]
        if digest(source) != item["new_sha256"]:
            raise RuntimeError("REVISION_SOURCE_HASH_MISMATCH: " + item["source"])
        current = digest(target)
        if current == item["new_sha256"]:
            continue
        if current != item["base_sha256"]:
            raise RuntimeError("WORKING_FILE_CHANGED: " + item["target"])
        changes.append((item, source, target))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = roots["backend"] / "artifacts" / ("odds-revision-" + stamp)
    backup.mkdir(parents=True, exist_ok=False)
    saved = []
    for item, source, target in changes:
        copy = backup / item["project"] / item["target"]
        existed = target.exists()
        if existed:
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, copy)
        saved.append({**item, "existed": existed, "target_absolute": str(target)})
    (backup / "manifest.json").write_text(json.dumps(saved, indent=2))
    applied = []
    try:
        for item, source, target in changes:
            atomic_copy(source, target)
            applied.append((item, target))
    except BaseException:
        for item, target in reversed(applied):
            original = backup / item["project"] / item["target"]
            if original.exists():
                atomic_copy(original, target)
            else:
                target.unlink(missing_ok=True)
        raise
    report = {"applied_files": len(applied), "backup": str(backup),
              "base_source_revision": plan["base_source_revision"],
              "unrelated_files_modified": False}
    (backup / "application.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == "__main__":
    main()
