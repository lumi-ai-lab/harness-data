#!/usr/bin/env python3
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"context", "posttool"}:
        print("usage: qdm_codex_hook.py <context|posttool>", file=sys.stderr)
        return 2

    cli = find_data_harness_cli(Path.cwd()) or find_data_harness_cli(Path(__file__).resolve().parent)
    if cli is None:
        print(f"data-harness-cli not found from {Path.cwd()}", file=sys.stderr)
        return 1

    proc = subprocess.run(
        [str(cli), sys.argv[1], "--format", "codex-hook"],
        cwd=cli.parent.parent,
        stdin=sys.stdin.buffer,
        stdout=sys.stdout.buffer,
        stderr=sys.stderr.buffer,
        check=False,
    )
    return proc.returncode


def find_data_harness_cli(start: Path) -> Optional[Path]:
    current = start.resolve()
    while True:
        for name in ("data-harness-cli", "data-harness-cli.exe"):
            candidate = current / "bin" / name
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return candidate
        if current.parent == current:
            return None
        current = current.parent


if __name__ == "__main__":
    raise SystemExit(main())
