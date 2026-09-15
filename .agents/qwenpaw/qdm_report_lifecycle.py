"""Narrow QwenPaw report/template completion bridge."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any, Mapping

from .qdm_subprocess import cli_command


_SESSION_KEY = re.compile(r"^qwenpaw:[0-9a-f]{64}$")
_SENSITIVE_ENVIRONMENT = frozenset({
    "HARNESS_AUTH_BLOB",
    "HARNESS_AUTH_BLOB_FILE",
    "HARNESS_AUTH_USER_ID",
    "QDM_AUTH_BLOB",
    "QDM_AUTH_BLOB_FILE",
})


@dataclass(frozen=True)
class LifecycleResult:
    additional_context: str = ""
    diagnostic_code: str = ""
    ok: bool = False


def complete_qdm_report(
    cli_path: Path,
    session_key: str | None,
    *,
    context_file: Path | None = None,
    additional_context_bytes: int | None = None,
    timeout_seconds: int = 60,
) -> LifecycleResult:
    """Complete the plugin-owned QwenPaw report stage for one session."""
    if not session_key or not _SESSION_KEY.fullmatch(session_key):
        return LifecycleResult(diagnostic_code="QDM_REPORT_LIFECYCLE_UNAVAILABLE")
    if not _valid_cli_path(cli_path):
        return LifecycleResult(diagnostic_code="QDM_REPORT_LIFECYCLE_UNAVAILABLE")
    if context_file is not None and (context_file.is_symlink() or not context_file.is_file()):
        return LifecycleResult(diagnostic_code="QDM_REPORT_LIFECYCLE_UNAVAILABLE")

    env = {
        key: value
        for key, value in os.environ.items()
        if key not in _SENSITIVE_ENVIRONMENT
    }
    stage = _run_cli(
        cli_path,
        ["stage", "template"],
        context_file=context_file,
        env=env,
        timeout_seconds=timeout_seconds,
    )
    if stage is None or stage.returncode != 0:
        return LifecycleResult(diagnostic_code="QDM_REPORT_STAGE_UNAVAILABLE")

    payload = json.dumps(
        {
            "session_id": session_key,
            "tool_name": "qdm_report_stage",
            "status": "success",
            "safe_command_args": {},
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    result = _run_cli(
        cli_path,
        ["posttool", "--format", "qwenpaw-hook"],
        context_file=context_file,
        env=env,
        input_text=payload,
        timeout_seconds=timeout_seconds,
    )
    return _parse_lifecycle_result(result, additional_context_bytes)


def complete_qdm_query(
    cli_path: Path,
    session_key: str | None,
    *,
    report_name: str | None,
    report_module: str | None,
    additional_context_bytes: int | None = None,
    timeout_seconds: int = 60,
) -> LifecycleResult:
    """Call the legacy plugin-owned qwenpaw-hook protocol after a query."""
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
    if not _valid_cli_path(cli_path):
        return LifecycleResult(diagnostic_code="QDM_REPORT_LIFECYCLE_UNAVAILABLE")
    try:
        result = subprocess.run(
            cli_command(cli_path, ["posttool", "--format", "qwenpaw-hook"]),
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
    return _parse_lifecycle_result(result, additional_context_bytes)


def _valid_cli_path(cli_path: Path) -> bool:
    return (
        not cli_path.is_symlink()
        and cli_path.is_file()
        and (os.name == "nt" or bool(cli_path.stat().st_mode & 0o100))
    )


def _run_cli(
    cli_path: Path,
    args: list[str],
    *,
    context_file: Path | None,
    env: dict[str, str],
    input_text: str | None = None,
    timeout_seconds: int,
) -> subprocess.CompletedProcess[str] | None:
    argv = cli_command(cli_path)
    if context_file is not None:
        argv += ["--context-file", str(context_file)]
    argv += args
    try:
        return subprocess.run(
            argv,
            cwd=str(cli_path.parent.parent),
            input=input_text,
            shell=False,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def _parse_lifecycle_result(
    result: subprocess.CompletedProcess[str] | None,
    additional_context_bytes: int | None,
) -> LifecycleResult:
    if result is None or result.returncode != 0:
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
