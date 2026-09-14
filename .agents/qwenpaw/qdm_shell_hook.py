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
    # A broad positive match intentionally sends ambiguous command text to the
    # adapter, which can reject it. Missing a path-qualified or quoted QDM
    # executable would incorrectly let the original command bypass the hook.
    return bool(_QDM_EXECUTABLE.search(command) and _QDM_OPERATION.search(command))


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
