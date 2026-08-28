"""Default-off, local-only channel requester ID diagnostic reply."""

from __future__ import annotations

from typing import Any

from agentscope.message import Msg, TextBlock
from qwenpaw.runtime.hooks import HookAction, HookResult

from .qdm_harness_context import input_text
from .qdm_identity import Requester


DEBUG_COMMAND = "/qdm-userid"


def debug_result(ctx: Any, requester: Requester, display_mode: str) -> HookResult | None:
    """Return a local reply for the exact debugging command, otherwise None."""
    if input_text(ctx) != DEBUG_COMMAND:
        return None
    if display_mode != "command":
        return HookResult(action=HookAction.SHORT_CIRCUIT)
    if requester.status != "resolved":
        return HookResult(
            action=HookAction.SHORT_CIRCUIT,
            payload=Msg(
                name="qdm-harness-qwenpaw",
                role="assistant",
                content=[TextBlock(type="text", text=_unavailable_message(requester))],
            ),
        )
    return HookResult(action=HookAction.SHORT_CIRCUIT, payload=Msg(name="qdm-harness-qwenpaw", role="assistant", content=[TextBlock(type="text", text=f"渠道：{requester.channel}\nUserID：{requester.user_id}")]))


def _unavailable_message(requester: Requester) -> str:
    reason = "身份不可用"
    if requester.reason == "group_not_confirmed_mentioned":
        reason = "群消息未检测到受信任的 @机器人 标记"
    return f"渠道：{requester.channel or 'unknown'}\n身份状态：不可用\n原因：{reason}"
