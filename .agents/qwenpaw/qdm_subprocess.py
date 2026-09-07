"""Cross-platform command construction for bundled Node CLI shims."""

from __future__ import annotations

import os
from pathlib import Path
import shutil


def _is_windows() -> bool:
    """Keep platform selection independently testable without mutating ``os.name``."""
    return os.name == "nt"


def cli_command(path: Path, args: list[str] | tuple[str, ...] = ()) -> list[str]:
    """Use a native executable or invoke an extensionless Node shim explicitly."""
    candidate = Path(path)
    if _is_windows():
        native = candidate if candidate.suffix.lower() == ".exe" else candidate.with_name(candidate.name + ".exe")
        if native.is_file() and not native.is_symlink():
            candidate = native
        elif candidate.suffix.lower() == ".exe" and not candidate.is_file():
            script = candidate.with_suffix("")
            if script.is_file() and not script.is_symlink():
                candidate = script
        if candidate.suffix.lower() not in {".exe", ".cmd", ".bat"}:
            return [shutil.which("node") or "node", str(candidate), *args]
    return [str(candidate), *args]
