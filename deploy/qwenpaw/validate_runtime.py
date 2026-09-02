#!/usr/bin/env python3
"""Fail-closed runtime validation for the QwenPaw Harness container."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys


CHANNEL_SECRET_DIR = Path("/run/secrets")
CHANNEL_AUTH_FILE = CHANNEL_SECRET_DIR / "channel-auth.json"
SESSION_SECRET_FILE = CHANNEL_SECRET_DIR / "session-hmac.secret"
PLUGIN_ROOT = Path("/app/working/plugins/qdm-harness-qwenpaw")


class ValidationError(RuntimeError):
    pass


def _fail(message: str) -> None:
    raise ValidationError(message)


def _regular_file(path: Path, *, owner: bool = False, private: bool = False) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as exc:
        _fail(f"required file is unavailable: {path}: {exc}")
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        _fail(f"required path must be a regular non-symlink file: {path}")
    if owner and (info.st_uid != os.geteuid() or info.st_gid != os.getegid()):
        _fail(f"file owner must match the QwenPaw process uid/gid: {path}")
    if private and stat.S_IMODE(info.st_mode) & 0o077:
        _fail(f"file permissions must be 0600 or stricter: {path}")
    return info


def _mount_point(path: Path) -> tuple[Path, set[str]] | None:
    target = path.resolve()
    best: tuple[Path, set[str]] | None = None
    try:
        lines = Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        try:
            before, after = line.split(" - ", 1)
            left = before.split()
            right = after.split()
            mount = Path(
                left[4]
                .replace("\\040", " ")
                .replace("\\011", "\t")
                .replace("\\012", "\n")
                .replace("\\134", "\\")
            ).resolve()
            if target != mount and mount not in target.parents:
                continue
            options = set(left[5].split(","))
            if len(right) >= 3:
                options.update(right[2].split(","))
            if best is None or len(mount.parts) > len(best[0].parts):
                best = (mount, options)
        except (IndexError, OSError, ValueError):
            continue
    return best


def _require_read_only_mount(path: Path) -> None:
    match = _mount_point(path)
    if match is None or "ro" not in match[1]:
        _fail(f"path must be backed by a read-only mount: {path}")


def _read_json(path: Path) -> dict:
    _regular_file(path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"invalid JSON file: {path}: {exc}")
    if not isinstance(value, dict):
        _fail(f"JSON root must be an object: {path}")
    return value


def validate() -> None:
    if os.geteuid() == 0:
        _fail("QwenPaw must not run as root")

    if not CHANNEL_SECRET_DIR.is_dir() or CHANNEL_SECRET_DIR.is_symlink():
        _fail(f"required secret directory is unavailable: {CHANNEL_SECRET_DIR}")
    _require_read_only_mount(CHANNEL_SECRET_DIR)
    _regular_file(CHANNEL_AUTH_FILE, owner=True, private=True)
    session_info = _regular_file(SESSION_SECRET_FILE, owner=True, private=True)
    if session_info.st_size < 32:
        _fail("session-hmac.secret must contain at least 32 bytes")

    config_path = Path(os.environ.get("HARNESS_PLUGIN_CONFIG", "/etc/qdm/qwenpaw/plugin-config.json"))
    config = _read_json(config_path)
    if config.get("schema_version") != 2:
        _fail(f"unsupported plugin config schema: {config_path}")
    if config.get("secret_ref") != str(CHANNEL_SECRET_DIR):
        _fail(f"plugin config must reference {CHANNEL_SECRET_DIR}")

    context_path = Path(str(config.get("root_context_path") or ""))
    if not context_path.is_absolute():
        _fail("root_context_path must be absolute")
    _read_json(context_path)
    instance_root = context_path.parent
    settings = _read_json(instance_root / "config" / "settings.json")

    metric_cli = Path(str(settings.get("metricCliPath") or ""))
    metric_info = _regular_file(metric_cli)
    if not metric_info.st_mode & stat.S_IXUSR:
        _fail(f"qdm-metric-cli must have owner execute permission: {metric_cli}")

    shim = PLUGIN_ROOT / "scripts" / "data-harness-cli"
    shim_info = _regular_file(shim)
    if not shim_info.st_mode & stat.S_IXUSR:
        _fail(f"data-harness-cli must have owner execute permission: {shim}")
    _regular_file(PLUGIN_ROOT / "plugin.json")
    _regular_file(Path("/app/working/config.json"))


def main() -> int:
    try:
        validate()
    except ValidationError as exc:
        print(f"qwenpaw runtime validation failed: {exc}", file=sys.stderr)
        return 78
    print("qwenpaw runtime validation ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
