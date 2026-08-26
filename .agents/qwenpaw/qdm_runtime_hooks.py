"""QwenPaw runtime hooks for identity, context and request-local tools."""

from __future__ import annotations

from contextvars import ContextVar, Token
import logging
from typing import Any

from agentscope.message import Msg, TextBlock
from qwenpaw.runtime.hooks import HookAction, HookBase, HookResult
from qwenpaw.runtime.phases import Phase

from .qdm_config import ConfigError, PluginConfig, load_config
from .qdm_debug_identity import debug_result
from .qdm_harness_context import HarnessContextError, input_text, request_context, session_key
from .qdm_identity import CONTEXT_KEY, Requester, requester_from_context, resolve_requester


logger = logging.getLogger("qwenpaw.plugins.qdm_harness")
requester_context: ContextVar[Requester | None] = ContextVar("qdm_harness_requester", default=None)
session_key_context: ContextVar[str | None] = ContextVar("qdm_harness_session_key", default=None)
_TOKEN_KEY = "qdm_harness_requester_token"
_SESSION_TOKEN_KEY = "qdm_harness_session_token"
UNAUTHORIZED_SESSION_CONSTRAINT = (
    "当前会话不具备 QDM 渠道授权身份。可以回答普通问题。不得调用、推测或编造 QDM 数据、"
    "权限范围或业务指标；用户提出数据查询时，提示其通过已配置的企微或飞书机器人发起请求。"
)


def _config_for_agent(ctx: Any) -> PluginConfig | None:
    try:
        config = load_config()
    except ConfigError:
        return None
    return config if getattr(ctx, "agent_id", "") == config.qdm_agent_id else None


class QdmRequesterIdentityHook(HookBase):
    phase = Phase.PRE_AGENT_BUILD
    name = "qdm_harness.requester_identity"
    priority = 10

    async def run(self, ctx: Any) -> HookResult:
        if _config_for_agent(ctx) is None:
            return HookResult()
        request = getattr(ctx, "request", None)
        if request is None:
            return HookResult(action=HookAction.SHORT_CIRCUIT, payload=_error_message("QDM 请求身份不可用"))
        requester = resolve_requester(getattr(request, "channel", ""), getattr(request, "channel_meta", None))
        current = getattr(request, "request_context", None)
        context = dict(current) if isinstance(current, dict) else {}
        context[CONTEXT_KEY] = requester.to_context()
        request.request_context = context
        return HookResult()


class QdmDebugIdentityHook(HookBase):
    phase = Phase.PRE_AGENT_BUILD
    name = "qdm_harness.debug_identity"
    priority = 20
    after = (QdmRequesterIdentityHook.name,)

    async def run(self, ctx: Any) -> HookResult:
        config = _config_for_agent(ctx)
        if config is None:
            return HookResult()
        requester = _requester(ctx)
        if requester is None:
            return HookResult()
        return debug_result(ctx, requester, config.user_id_display_mode) or HookResult()


class QwenPawHarnessContextHook(HookBase):
    phase = Phase.PRE_AGENT_BUILD
    name = "qdm_harness.harness_context"
    priority = 30
    after = (QdmDebugIdentityHook.name,)

    async def run(self, ctx: Any) -> HookResult:
        config = _config_for_agent(ctx)
        if config is None:
            return HookResult()
        requester = _requester(ctx)
        if requester is None:
            return HookResult()
        if requester.status != "resolved":
            if requester.reason == "group_not_confirmed_mentioned":
                return HookResult(action=HookAction.SHORT_CIRCUIT, payload=_error_message("QDM 请求身份不可用"))
            ctx.inject_context(UNAUTHORIZED_SESSION_CONSTRAINT, priority=100, source="qdm-harness-channel-boundary")
            return HookResult()
        try:
            key = session_key(config.session_secret_file, requester.channel, str(getattr(ctx, "session_id", "")))
            content = request_context(config.data_harness_cli, key, input_text(ctx), context_limits=config.context_limits)
        except HarnessContextError as exc:
            logger.warning("qdm_harness_context_failed reason=%s", exc.reason)
            return HookResult(action=HookAction.SHORT_CIRCUIT, payload=_error_message("Harness 上下文不可用"))
        ctx.inject_context(content, priority=100, source="qdm-harness")
        return HookResult()


class QdmRequesterContextHook(HookBase):
    phase = Phase.PRE_EXECUTE
    name = "qdm_harness.requester_bind"
    priority = 10

    async def run(self, ctx: Any) -> HookResult:
        if _config_for_agent(ctx) is None:
            return HookResult()
        requester = _requester(ctx)
        ctx.extras[_TOKEN_KEY] = requester_context.set(
            requester if requester is not None and requester.status == "resolved" else None,
        )
        session_token = None
        if requester is not None and requester.status == "resolved":
            try:
                config = load_config()
                session_token = session_key_context.set(
                    session_key(config.session_secret_file, requester.channel, str(getattr(ctx, "session_id", ""))),
                )
            except HarnessContextError:
                session_token = None
        ctx.extras[_SESSION_TOKEN_KEY] = session_token
        return HookResult()


class QdmRequesterCleanupHook(HookBase):
    priority = 10

    def __init__(self, phase: Phase) -> None:
        self.phase = phase
        self.name = f"qdm_harness.requester_cleanup.{phase.value}"

    async def run(self, ctx: Any) -> HookResult:
        token = ctx.extras.pop(_TOKEN_KEY, None)
        if isinstance(token, Token):
            requester_context.reset(token)
        session_token = ctx.extras.pop(_SESSION_TOKEN_KEY, None)
        if isinstance(session_token, Token):
            session_key_context.reset(session_token)
        return HookResult()


def hook_factories() -> tuple[tuple[str, Any, int], ...]:
    return (
        (QdmRequesterIdentityHook.name, QdmRequesterIdentityHook, 10),
        (QdmDebugIdentityHook.name, QdmDebugIdentityHook, 20),
        (QwenPawHarnessContextHook.name, QwenPawHarnessContextHook, 30),
        (QdmRequesterContextHook.name, QdmRequesterContextHook, 10),
        ("qdm_harness.requester_cleanup.post_response", lambda: QdmRequesterCleanupHook(Phase.POST_RESPONSE), 10),
        ("qdm_harness.requester_cleanup.on_error", lambda: QdmRequesterCleanupHook(Phase.ON_ERROR), 10),
    )


def _requester(ctx: Any) -> Requester | None:
    request = getattr(ctx, "request", None)
    return requester_from_context(getattr(request, "request_context", {}).get(CONTEXT_KEY)) if request else None


def _error_message(text: str) -> Msg:
    return Msg(name="qdm-harness-qwenpaw", role="assistant", content=[TextBlock(type="text", text=text)])
