"""Safe bridge to data-harness-cli context --format agent-hook."""

from __future__ import annotations

import hashlib
import hmac
import json
import subprocess
import os
import stat
from pathlib import Path, PurePath
from typing import Any, Mapping

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
returned by `qdm_scope_summary` is authoritative for this session.
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
    timeout_seconds: int = 20,
) -> str:
    """Build Harness context and embed only CLI-selected Wiki Markdown files.

    The data-harness CLI is the authoritative selector.  This function merely
    consumes its structured allow-list; it never exposes a general file tool
    to the model.
    """
    if cli_path.is_symlink() or not cli_path.is_file() or (os.name != "nt" and not cli_path.stat().st_mode & stat.S_IXUSR):
        raise HarnessContextError("context_cli_unavailable")
    payload = json.dumps({"session_id": session_id, "prompt": prompt}, ensure_ascii=False)
    try:
        result = subprocess.run([str(cli_path), "context", "--format", "agent-hook"], input=payload, cwd=str(cli_path.parent.parent), shell=False, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        raise HarnessContextError("context_cli_timeout") from exc
    except OSError as exc:
        raise HarnessContextError("context_cli_unavailable") from exc
    if result.returncode != 0:
        raise HarnessContextError(_context_cli_failure_reason(result.stderr, result.stdout))
    try:
        output: Any = json.loads(result.stdout)
        hook_output = output["hookSpecificOutput"]
        content = hook_output["additionalContext"]
        context_files = hook_output["contextFiles"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise HarnessContextError("context_protocol_invalid") from exc
    if not isinstance(content, str) or not content.strip():
        raise HarnessContextError("context_empty")
    limits = context_limits or ContextLimits()
    if _exceeds_limit(len(content.encode("utf-8")), limits.base_context_bytes):
        raise HarnessContextError("context_base_too_large")
    manuals = _selected_wiki_manuals(cli_path.parent.parent, context_files, context_limits=limits)
    # Append after selected manuals so this channel-specific policy wins over
    # legacy generic Harness instructions that may mention auth describe.
    return content + manuals + "\n\n" + QWENPAW_TOOL_POLICY + "\n"


def _selected_wiki_manuals(
    runtime_root: Path,
    context_files: Any,
    *,
    context_limits: ContextLimits | None = None,
) -> str:
    if not isinstance(context_files, list) or not context_files:
        raise HarnessContextError("context_files_invalid")
    try:
        wiki_root = runtime_root / "wikis"
        if runtime_root.is_symlink() or wiki_root.is_symlink() or not wiki_root.is_dir():
            raise HarnessContextError("wiki_root_unavailable")
        resolved_wiki_root = wiki_root.resolve(strict=True)
    except OSError as exc:
        raise HarnessContextError("wiki_root_unavailable") from exc

    limits = context_limits or ContextLimits()
    total = 0
    blocks: list[str] = ["\n\n# QDM Harness selected manuals\n\nThe following manuals were selected by the trusted Harness runtime. Use their metric codes and parameter contracts; do not guess identifiers.\n"]
    seen: set[str] = set()
    for item in context_files:
        if not isinstance(item, Mapping):
            raise HarnessContextError("context_files_invalid")
        logical_path = item.get("path")
        if not isinstance(logical_path, str):
            raise HarnessContextError("context_files_invalid")
        parts = _wiki_path_parts(logical_path)
        normalized = "/".join(parts)
        if normalized in seen:
            continue
        seen.add(normalized)
        candidate = runtime_root.joinpath(*parts)
        try:
            _reject_symlink_components(runtime_root, parts)
            resolved = candidate.resolve(strict=True)
            if not resolved.is_file() or not resolved.is_relative_to(resolved_wiki_root):
                raise HarnessContextError("context_file_outside_wikis")
            data = resolved.read_bytes()
        except OSError as exc:
            raise HarnessContextError("context_file_unavailable") from exc
        if _exceeds_limit(len(data), limits.wiki_file_bytes) or _exceeds_limit(total + len(data), limits.wiki_total_bytes):
            raise HarnessContextError("context_manuals_too_large")
        try:
            body = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HarnessContextError("context_file_encoding_invalid") from exc
        total += len(data)
        blocks.append(f"\n--- {normalized} ---\n{body}\n")
    if not seen:
        raise HarnessContextError("context_files_empty")
    return "".join(blocks)


def _exceeds_limit(actual: int, limit: int | None) -> bool:
    return limit is not None and actual > limit


def _wiki_path_parts(value: str) -> tuple[str, ...]:
    normalized = value.replace("\\", "/")
    parts = tuple(normalized.split("/"))
    if (
        not value
        or PurePath(value).is_absolute()
        or len(parts) < 2
        or parts[0] != "wikis"
        or any(not part or part in {".", ".."} for part in parts)
        or parts[-1].lower().endswith(".md") is False
        or "templates" in parts
    ):
        raise HarnessContextError("context_file_path_invalid")
    return parts


def _reject_symlink_components(root: Path, parts: tuple[str, ...]) -> None:
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise HarnessContextError("context_file_symlink_rejected")


def _context_cli_failure_reason(stderr: str, stdout: str) -> str:
    """Classify a known setup error without recording untrusted CLI text."""
    text = f"{stderr}\n{stdout}".casefold()
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
