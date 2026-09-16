"""QwenPaw Shell middleware for authorized QDM CLI commands."""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import AsyncGenerator, Callable, Mapping
from pathlib import PurePath
from typing import Any

from agentscope.message import TextBlock, ToolResultState
from agentscope.middleware import MiddlewareBase
from agentscope.tool import ToolChunk

from .qdm_channel_auth import ChannelAuthorizationError
from .qdm_cli import QdmCliError, QdmCliExecutor
from .qdm_runtime_hooks import authorization_snapshot_context, requester_context


QDM_SHELL_TOOL_NAME = "execute_shell_command"
_QDM_EXECUTABLE = re.compile(r"(?i)qdm-metric-cli(?:\.exe)?")
_QDM_OPERATION = re.compile(r"(?is)\b(?:analysis\s+execute|auth\s+describe)\b")
_QDM_CLI_TOKEN = re.compile(
    r"""(?ix)
    (?:
        qdm-metric-cli(?:\.exe)?
        | \${?QDM_METRIC_CLI(?::-[^}]*)?}?
        | (?:
            [A-Za-z]:[\\/]
            | \.{1,2}[\\/]
            | /
            | (?:[^/\\;|&'"\r\n]+[\\/])+
          )
          [^;|&'"\r\n]*[\\/]qdm-metric-cli(?:\.exe)?
    )
    """
)
_DIALECTS = frozenset({"bash", "powershell", "cmd"})
_SAFE_MESSAGES = {
    "QDM_CONFIG_INVALID": "QDM 插件配置无效",
    "QDM_CHANNEL_IDENTITY_UNAVAILABLE": "当前会话不支持 QDM 数据查询",
    "QDM_CHANNEL_IDENTITY_MISMATCH": "当前请求身份与授权上下文不一致",
    "QDM_RUNTIME_MCP_UNAVAILABLE": "QDM Runtime MCP 不可用",
    "QDM_CHANNEL_AUTH_DENIED": "QDM 渠道授权不可用或被拒绝",
    "QDM_AUTHZ_INPUT_INVALID": "QDM Shell 请求格式无效",
    "QDM_AUTHZ_TOOL_UNSUPPORTED": "QDM Shell 工具不受支持",
    "QDM_AUTHZ_BLOB_INVALID": "QDM 授权凭据无效",
    "QDM_SHELL_DIALECT_UNAVAILABLE": "当前 Shell 执行器方言不可用",
    "QDM_MEASURES_JSON_REQUIRED": "QDM analysis execute 必须使用 --measures-json",
    "QDM_MEASURES_JSON_INVALID": "--measures-json 参数无效",
    "QDM_AUTH_CAPABILITY_DENIED": "当前用户没有 QDM 数据查询权限",
    "QDM_CLI_UNAVAILABLE": "QDM CLI 不可用",
    "QDM_CLI_TIMEOUT": "QDM 授权请求超时",
    "QDM_AUTHZ_COMMAND_AMBIGUOUS": "一次 Shell 调用只能包含一条 QDM 查询命令",
    "QDM_AUTHZ_COMMAND_UNSUPPORTED": "QDM Shell 命令形状不受支持",
    "QDM_AUTHZ_REWRITE_FAILED": "QDM Shell 命令无法安全改写",
    "QDM_AUTHZ_PROTOCOL_INVALID": "QDM 授权服务响应无效",
}


class QdmShellHookMiddleware(MiddlewareBase):
    """Authorize QDM Shell calls and leave all other Shell calls unchanged."""

    def __init__(
        self,
        provider: Any | None,
        executor: QdmCliExecutor | None,
        *,
        session_id: str = "",
        agent_id: str = "",
        allowed_dialects: set[str] | frozenset[str] | None = None,
        initialization_error: str | None = None,
    ) -> None:
        self._provider = provider
        self._executor = executor
        self._session_id = session_id
        self._agent_id = agent_id
        self._allowed_dialects = frozenset(allowed_dialects or _DIALECTS)
        self._initialization_error = initialization_error

    async def on_acting(
        self,
        agent: Any,
        input_kwargs: dict[str, Any],
        next_handler: Callable[..., AsyncGenerator[Any, None]],
    ) -> AsyncGenerator[Any, None]:
        tool_call = input_kwargs.get("tool_call")
        if getattr(tool_call, "name", "") != QDM_SHELL_TOOL_NAME:
            async for item in next_handler(tool_call=tool_call):
                yield item
            return

        try:
            tool_input, input_is_json = _normalize_tool_input(tool_call)
        except (TypeError, ValueError):
            yield _failure("QDM_AUTHZ_INPUT_INVALID")
            return
        command = tool_input["command"]

        # Do not fetch identity or Blob for ordinary Shell work.
        if not looks_like_qdm_command(command):
            async for item in next_handler(tool_call=tool_call):
                yield item
            return

        dialect = shell_dialect()
        if dialect is None or dialect not in self._allowed_dialects:
            yield _failure("QDM_SHELL_DIALECT_UNAVAILABLE")
            return

        requester = requester_context.get()
        if requester is None or requester.status != "resolved":
            yield _failure("QDM_CHANNEL_IDENTITY_UNAVAILABLE")
            return
        if self._initialization_error:
            yield _failure(self._initialization_error)
            return
        if self._provider is None or self._executor is None:
            yield _failure("QDM_RUNTIME_MCP_UNAVAILABLE")
            return

        try:
            blob = await self._blob_for(requester)
            updated_command = await asyncio.to_thread(
                self._executor.authorize_shell,
                dialect=dialect,
                command=command,
                blob=blob,
                request={
                    "channel": requester.channel,
                    "session_id": self._session_id,
                    "agent_id": self._agent_id,
                },
            )
            if updated_command is None:
                async for item in next_handler(tool_call=tool_call):
                    yield item
                return
            if not isinstance(updated_command, str) or not updated_command.strip():
                raise QdmCliError("QDM_AUTHZ_PROTOCOL_INVALID", "授权服务未返回改写后的命令")
            try:
                tool_input["command"] = updated_command
                if input_is_json:
                    tool_call.input = json.dumps(tool_input, ensure_ascii=False)
            except Exception:
                yield _failure("QDM_AUTHZ_PROTOCOL_INVALID")
                return
        except QdmCliError as exc:
            yield _failure(exc.code)
            return
        except ChannelAuthorizationError:
            yield _failure("QDM_CHANNEL_AUTH_DENIED")
            return
        except Exception:
            yield _failure("QDM_RUNTIME_MCP_UNAVAILABLE")
            return

        async for item in next_handler(tool_call=tool_call):
            yield item

    async def _blob_for(self, requester: Any) -> str:
        snapshot = authorization_snapshot_context.get()
        if (
            snapshot is not None
            and getattr(snapshot, "requester", None) == requester
            and isinstance(getattr(snapshot, "blob", None), str)
        ):
            return snapshot.blob
        return await asyncio.to_thread(self._provider.blob_for, requester)


def _normalize_tool_input(tool_call: Any) -> tuple[Mapping[str, Any], bool]:
    """Return a validated object while preserving the host input representation."""
    raw_input = getattr(tool_call, "input", None)
    if isinstance(raw_input, Mapping):
        normalized = raw_input
        input_is_json = False
    elif isinstance(raw_input, str):
        try:
            normalized = json.loads(raw_input)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError("tool input is not valid JSON") from exc
        if not isinstance(normalized, dict):
            raise ValueError("tool input JSON must be an object")
        input_is_json = True
    else:
        raise TypeError("tool input must be a mapping or JSON string")

    command = normalized.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("tool input command is missing")
    return normalized, input_is_json


def looks_like_qdm_command(command: str) -> bool:
    """Conservatively identify the QDM command shapes handled by the adapter."""
    # Keep the Python prefilter aligned with the Node adapter: ordinary quoted
    # text and HereDoc bodies are masked, while a quoted CLI token remains
    # visible for the operation check.
    masked = _mask_non_command_regions(command)
    return bool(_QDM_EXECUTABLE.search(masked) and _QDM_OPERATION.search(masked))


def _mask_non_command_regions(command: str) -> str:
    chars = list(command)
    length = len(chars)

    def space_out(start: int, end: int) -> None:
        for index in range(start, min(end, length)):
            if chars[index] not in {"\n", "\r"}:
                chars[index] = " "

    def heredoc_at(index: int) -> tuple[int, str] | None:
        match = re.match(r"<<-?\s*(?:(['\"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))", "".join(chars[index:]))
        if not match:
            return None
        tag = match.group(2) or match.group(3)
        body_start = index + match.end()
        while body_start < length and chars[body_start] != "\n":
            body_start += 1
        if body_start < length:
            body_start += 1
        cursor = body_start
        while cursor < length:
            line_start = cursor
            while line_start < length and chars[line_start] == "\t":
                line_start += 1
            if "".join(chars[line_start:line_start + len(tag)]) == tag:
                after = line_start + len(tag)
                if after >= length or chars[after] in {"\n", "\r"}:
                    return body_start, line_start
            while cursor < length and chars[cursor] != "\n":
                cursor += 1
            if cursor < length:
                cursor += 1
        return body_start, length

    index = 0
    while index < length:
        if chars[index] == "<" and index + 1 < length and chars[index + 1] == "<":
            region = heredoc_at(index)
            if region is not None:
                space_out(*region)
                index = region[1]
                continue

        if chars[index] == "'":
            end = index + 1
            while end < length and chars[end] != "'":
                end += 1
            if end >= length:
                space_out(index + 1, length)
                break
            inner = "".join(chars[index + 1:end])
            if not _is_metric_cli_token(inner):
                space_out(index + 1, end)
            index = end + 1
            continue

        if chars[index] == "$" and index + 1 < length and chars[index + 1] == "'":
            end = index + 2
            while end < length:
                if chars[end] == "\\" and end + 1 < length:
                    end += 2
                    continue
                if chars[end] == "'":
                    break
                end += 1
            if end >= length:
                space_out(index + 2, length)
                break
            space_out(index + 2, end)
            index = end + 1
            continue

        if chars[index] == '"':
            end = index + 1
            while end < length:
                if chars[end] == "\\" and end + 1 < length:
                    end += 2
                    continue
                if chars[end] == '"':
                    break
                end += 1
            if end >= length:
                space_out(index + 1, length)
                break
            inner = "".join(chars[index + 1:end])
            if not _is_metric_cli_token(inner):
                space_out(index + 1, end)
            index = end + 1
            continue
        index += 1
    return "".join(chars)


def _is_metric_cli_token(value: str) -> bool:
    return bool(_QDM_CLI_TOKEN.fullmatch(value.strip()))


def shell_dialect() -> str | None:
    """Map the host-provided Shell executable to the adapter dialect."""
    try:
        from qwenpaw.config.context import get_current_shell_command_executable

        executable = get_current_shell_command_executable()
    except Exception:
        executable = None
    if not isinstance(executable, str) or not executable.strip():
        return "cmd" if os.name == "nt" else None
    name = PurePath(executable.strip().replace("\\", "/")).name.casefold()
    if name in {"bash", "sh", "git-bash", "git-bash.exe"}:
        return "bash"
    if name in {"powershell", "powershell.exe", "pwsh", "pwsh.exe"}:
        return "powershell"
    if name in {"cmd", "cmd.exe"}:
        return "cmd"
    return None


def _failure(code: str) -> ToolChunk:
    message = _SAFE_MESSAGES.get(code, "QDM Shell 查询未获准")
    return ToolChunk(
        is_last=True,
        state=ToolResultState.DENIED,
        content=[TextBlock(type="text", text=f"{code}: {message}")],
    )
