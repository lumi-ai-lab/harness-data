"""Default-off, local-only channel requester ID diagnostic reply."""

from __future__ import annotations

from typing import Any

from agentscope.message import Msg, TextBlock
from qwenpaw.runtime.hooks import HookAction, HookResult

from .qdm_harness_context import input_text
from .qdm_identity import Requester


DEBUG_COMMAND = "/qdm-userid"

_RELOAD_BRIDGE_LABELS = {
    "installed": "已安装",
    "not_needed": "不需要（宿主原生支持工作区钩子）",
    "unavailable": "未安装（工作管理器未就绪）",
    "unknown": "未评估",
}
_reload_bridge_state = "unknown"


def record_reload_bridge_state(state: str) -> None:
    """Remember how the QwenPaw reload compatibility bridge settled."""
    global _reload_bridge_state
    if state in _RELOAD_BRIDGE_LABELS:
        _reload_bridge_state = state


def debug_result(ctx: Any, requester: Requester | None, display_mode: str) -> HookResult | None:
    """Return a local reply for the exact debugging command, otherwise None."""
    if input_text(ctx) != DEBUG_COMMAND:
        return None
    if display_mode != "command":
        return HookResult(action=HookAction.SHORT_CIRCUIT)
    bridge = f"热重载兼容桥：{_RELOAD_BRIDGE_LABELS[_reload_bridge_state]}"
    if requester is None:
        # The identity hook writes request_context unconditionally, so a missing
        # entry means this workspace never ran it.
        return _reply(f"身份解析钩子：未运行（工作区重载后未恢复）\n{bridge}")
    if requester.status != "resolved":
        return _reply(f"{_unavailable_message(requester)}\n{bridge}")
    return _reply(f"渠道：{requester.channel}\nUserID：{requester.user_id}\n{bridge}")


def _reply(text: str) -> HookResult:
    return HookResult(
        action=HookAction.SHORT_CIRCUIT,
        payload=Msg(name="qdm-harness-qwenpaw", role="assistant", content=[TextBlock(type="text", text=text)]),
    )


def _unavailable_message(requester: Requester) -> str:
    reason = "身份不可用"
    if requester.reason == "group_not_confirmed_mentioned":
        reason = "群消息未检测到受信任的 @机器人 标记"
    return f"渠道：{requester.channel or 'unknown'}\n身份状态：不可用\n原因：{reason}"
