"""Safe bridge to data-harness-cli context --format qwenpaw-hook.

The CLI is the authoritative selector and embeds the selected wiki manuals
directly into the additional context; this module only forwards the session
payload and sanitizes the embedded instruction text.  It never reads wiki
files itself (plan.md §6).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import subprocess
import os
import stat
from pathlib import Path
from typing import Any

from .qdm_config import ContextLimits


class HarnessContextError(RuntimeError):
    """The required Harness semantic context cannot be supplied."""

    def __init__(self, reason: str = "context_unavailable") -> None:
        super().__init__("Harness 上下文不可用")
        self.reason = reason


QWENPAW_TOOL_POLICY = """
# QwenPaw channel tool policy (authoritative)
This is a QwenPaw channel session. For QDM permission or scope questions, call
`qdm_scope_summary`; never ask the user to run `qdm-metric-cli auth describe`
or any Shell/CLI command. Do not generate or request Blob, Secret, authorization
file contents, CLI paths, or authentication flags. Use only `qdm_query`,
`qdm_scope_summary`, and `get_current_time` for QDM work. The permission summary
returned by `qdm_scope_summary` is authoritative only for the current inbound
request. Never reuse a prior summary, chat-history scope, Agent memory, session
state, or another user's permissions. Area, store, and category filters must
come from the current message; if no area is specified, do not inherit one from
an earlier turn.
""".strip()


def session_key(secret_file: Path, channel: str, original_session_id: str) -> str:
    try:
        if secret_file.is_symlink() or not secret_file.is_file():
            raise HarnessContextError("session_secret_unavailable")
        secret = secret_file.read_bytes()
    except OSError as exc:
        raise HarnessContextError("session_secret_unavailable") from exc
    if len(secret) < 32:
        raise HarnessContextError("session_secret_invalid")
    message = channel.encode("utf-8") + b"\0" + original_session_id.encode("utf-8")
    return "qwenpaw:" + hmac.new(secret, message, hashlib.sha256).hexdigest()


def request_context(
    cli_path: Path,
    session_id: str,
    prompt: str,
    *,
    context_limits: ContextLimits | None = None,
    timeout_seconds: int = 60,
    context_file: Path | None = None,
) -> str:
    """Build Harness context from the CLI's qwenpaw-hook output.

    The data-harness CLI is the authoritative selector and embeds the selected
    wiki manuals; the model never receives a general file tool for them.
    """
    if cli_path.is_symlink() or not cli_path.is_file() or (os.name != "nt" and not cli_path.stat().st_mode & stat.S_IXUSR):
        raise HarnessContextError("context_cli_unavailable")
    payload: dict[str, Any] = {"session_id": session_id, "prompt": prompt}
    workspace = os.environ.get("HARNESS_WORKSPACE_ROOT") or ""
    if workspace:
        payload["cwd"] = workspace
    payload_json = json.dumps(payload, ensure_ascii=False)
    argv = [str(cli_path)]
    if context_file is not None:
        if context_file.is_symlink() or not context_file.is_file():
            raise HarnessContextError("context_file_unavailable")
        argv += ["--context-file", str(context_file)]
    argv += ["context", "--format", "qwenpaw-hook"]
    env = dict(os.environ)
    # QwenPaw is a read-only host whose plugin always expects the injected
    # Harness manuals; the CLI's default on-demand mode would skip injection.
    env["QDM_HARNESS_HOOK_MODE"] = "auto-context"
    try:
        result = subprocess.run(argv, input=payload_json, cwd=str(cli_path.parent.parent), shell=False, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout_seconds, env=env)
    except subprocess.TimeoutExpired as exc:
        raise HarnessContextError("context_cli_timeout") from exc
    except OSError as exc:
        raise HarnessContextError("context_cli_unavailable") from exc
    if result.returncode != 0:
        raise HarnessContextError(_context_cli_failure_reason(result.stderr, result.stdout))
    try:
        output: Any = json.loads(result.stdout)
        content = output["hookSpecificOutput"]["additionalContext"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise HarnessContextError("context_protocol_invalid") from exc
    if not isinstance(content, str) or not content.strip():
        raise HarnessContextError("context_empty")
    # The generic Harness prompt historically told agents to read contextFiles
    # with their host file tool. QwenPaw has no such tool; the CLI has already
    # embedded those files, so rewrite the instruction accordingly.
    content = _sanitize_embedded_context_instruction(content)
    limits = context_limits or ContextLimits()
    if _exceeds_limit(len(content.encode("utf-8")), limits.base_context_bytes):
        raise HarnessContextError("context_base_too_large")
    return content + "\n\n" + QWENPAW_TOOL_POLICY + "\n"


def _sanitize_embedded_context_instruction(content: str) -> str:
    replacements = {
        "必须先读取以下 contextFiles：": "以下 contextFiles 已由可信 Harness 读取并以内嵌 Markdown 提供；禁止再次使用 Read、Shell 或其他文件工具读取这些路径：",
        "All modes: read all contextFiles before running data CLI.": "The trusted Harness has already read and embedded every contextFile below; do not call Read, Shell, or any file tool for those paths.",
        "Read every selected playbook in contextFiles.": "Use the selected playbook content embedded below; do not read its path again.",
        "Read the report index when present": "Use the report index content embedded below when present",
    }
    for old, new in replacements.items():
        content = content.replace(old, new)
    return content


def _exceeds_limit(actual: int, limit: int | None) -> bool:
    return limit is not None and actual > limit


def _context_cli_failure_reason(stderr: str, stdout: str) -> str:
    """Classify a known setup error without recording untrusted CLI text."""
    text = f"{stderr}\n{stdout}".casefold()
    if "failed to embed selected manuals" in text:
        return "missing_selected_manual"
    if "wikis-index.json" in text or "wikis-runtime-index.json" in text:
        return "missing_wiki_index"
    return "context_cli_failed"


def input_text(ctx: Any) -> str:
    messages = getattr(ctx, "input_msgs", None)
    if not isinstance(messages, list) or not messages:
        return ""
    getter = getattr(messages[-1], "get_text_content", None)
    value = getter() if callable(getter) else ""
    return value.strip() if isinstance(value, str) else ""
