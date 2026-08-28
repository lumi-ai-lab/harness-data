"""Narrow QwenPaw report/template completion bridge."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
import stat
from pathlib import Path
import subprocess
from typing import Any, Mapping




@dataclass(frozen=True)
class LifecycleResult:
    additional_context: str = ""
    diagnostic_code: str = ""
    ok: bool = False


def complete_qdm_query(
    cli_path: Path,
    session_key: str | None,
    *,
    report_name: str | None,
    report_module: str | None,
    additional_context_bytes: int | None = None,
    timeout_seconds: int = 60,
) -> LifecycleResult:
    """Call only the plugin-owned qwenpaw-hook protocol after a query."""
    if not session_key:
        return LifecycleResult(diagnostic_code="QDM_REPORT_LIFECYCLE_UNAVAILABLE")
    safe_args: dict[str, str] = {}
    if report_name:
        safe_args["report_name"] = report_name
    if report_module:
        safe_args["report_module"] = report_module
    payload = json.dumps(
        {
            "session_id": session_key,
            "tool_name": "qdm_query",
            "status": "success",
            "safe_command_args": safe_args,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if cli_path.is_symlink() or not cli_path.is_file() or (os.name != "nt" and not cli_path.stat().st_mode & stat.S_IXUSR):
        return LifecycleResult(diagnostic_code="QDM_REPORT_LIFECYCLE_UNAVAILABLE")
    try:
        result = subprocess.run(
            [str(cli_path), "posttool", "--format", "qwenpaw-hook"],
            cwd=str(cli_path.parent.parent),
            input=payload,
            shell=False,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except (OSError, subprocess.TimeoutExpired):
        return LifecycleResult(diagnostic_code="QDM_REPORT_LIFECYCLE_UNAVAILABLE")
    if result.returncode != 0:
        return LifecycleResult(diagnostic_code="QDM_REPORT_LIFECYCLE_UNAVAILABLE")
    try:
        output: Any = json.loads(result.stdout)
    except json.JSONDecodeError:
        return LifecycleResult(diagnostic_code="QDM_REPORT_LIFECYCLE_UNAVAILABLE")
    if not isinstance(output, Mapping):
        return LifecycleResult(diagnostic_code="QDM_REPORT_LIFECYCLE_UNAVAILABLE")
    context = output.get("additional_context", "")
    code = output.get("diagnostic_code", "")
    ok = output.get("ok")
    if not isinstance(context, str):
        return LifecycleResult(diagnostic_code="QDM_REPORT_CONTEXT_INVALID")
    if additional_context_bytes is not None and len(context.encode("utf-8")) > additional_context_bytes:
        return LifecycleResult(diagnostic_code="QDM_REPORT_CONTEXT_TOO_LARGE")
    if not isinstance(code, str) or len(code) > 128 or not isinstance(ok, bool):
        return LifecycleResult(diagnostic_code="QDM_REPORT_CONTEXT_INVALID")
    return LifecycleResult(additional_context=context, diagnostic_code=code, ok=ok)
