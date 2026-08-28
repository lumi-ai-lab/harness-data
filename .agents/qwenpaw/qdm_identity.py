"""Trusted QwenPaw channel identity extraction without tenant identifiers."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Mapping


CONTEXT_KEY = "qdm_requester"


@dataclass(frozen=True)
class Requester:
    schema_version: int
    status: str
    channel: str
    user_id: str
    chat_type: str
    chat_id: str = ""
    reason: str = ""

    def to_context(self) -> dict[str, str | int]:
        return asdict(self)


def resolve_requester(channel: Any, channel_meta: Any) -> Requester:
    """Return a fail-closed identity derived solely from ``channel_meta``."""
    name = _text(channel).casefold()
    meta = channel_meta if isinstance(channel_meta, Mapping) else {}
    if name not in {"wecom", "feishu"}:
        return _unavailable(name, "unsupported_channel")
    is_group = bool(meta.get("is_group"))
    chat_type = "group" if is_group else "single"
    # The official WeCom AI Bot channel only routes @bot group messages to an
    # Agent.  QwenPaw 2.1.x does not expose a separate mention field for that
    # trusted routing decision, so its non-empty sender ID is sufficient here.
    # Feishu routes group traffic differently and must retain its explicit
    # channel-provided mention marker.
    if is_group and name != "wecom" and meta.get("bot_mentioned") is not True:
        return _unavailable(name, "group_not_confirmed_mentioned", chat_type)
    if name == "wecom":
        user_id = _text(meta.get("wecom_sender_id"))
        chat_id = _text(meta.get("wecom_chatid"))
    else:
        user_id = _text(meta.get("feishu_sender_id"))
        chat_id = _text(meta.get("feishu_chat_id"))
        if meta.get("feishu_thread_id"):
            return _unavailable(name, "feishu_thread_unsupported", chat_type)
        if bool(meta.get("feishu_share_session_in_group")):
            return _unavailable(name, "feishu_shared_session_unsupported", chat_type)
    if not _real_user_id(user_id):
        return _unavailable(name, "missing_or_non_person_sender", chat_type)
    return Requester(1, "resolved", name, user_id, chat_type, chat_id)


def requester_from_context(value: Any) -> Requester | None:
    if not isinstance(value, Mapping):
        return None
    try:
        result = Requester(
            int(value.get("schema_version")),
            str(value.get("status")),
            str(value.get("channel")),
            str(value.get("user_id")),
            str(value.get("chat_type")),
            str(value.get("chat_id") or ""),
            str(value.get("reason") or ""),
        )
    except (TypeError, ValueError):
        return None
    if result.status == "unavailable":
        if result.user_id or result.chat_type not in {"", "single", "group"} or not result.reason:
            return None
        return result
    if result.status != "resolved" or result.channel not in {"wecom", "feishu"}:
        return None
    if result.chat_type not in {"single", "group"} or not _real_user_id(result.user_id):
        return None
    return result


def _unavailable(channel: str, reason: str, chat_type: str = "") -> Requester:
    return Requester(1, "unavailable", channel, "", chat_type, reason=reason)


def _real_user_id(value: str) -> bool:
    lowered = value.casefold()
    return bool(value) and lowered != "group" and not lowered.startswith(("thread:", "unknown_"))


def _text(value: Any) -> str:
    return str(value or "").strip()
