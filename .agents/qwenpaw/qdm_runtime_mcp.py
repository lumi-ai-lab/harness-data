"""Minimal Streamable HTTP MCP client for runtime authorization lookup.

The client deliberately exposes only ``blob_for`` and maps every transport or
protocol failure to a non-sensitive authorization error.  It uses the Python
stdlib so the QwenPaw plugin package gains no runtime dependency on an MCP SDK.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import stat
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from .qdm_identity import Requester
from .qdm_channel_auth import ChannelAuthorizationError


logger = logging.getLogger("qwenpaw.plugins.qdm_harness")


class RuntimeMcpConfigError(ValueError):
    """Operator configuration is invalid for runtime MCP."""


class RuntimeMcpAuthProvider:
    """Resolve a channel/user pair through qdm-auth-center runtime MCP."""

    def __init__(
        self,
        endpoint: str,
        token_file: Path,
        *,
        timeout_seconds: int = 10,
        max_response_bytes: int = 1 * 1024 * 1024,
    ) -> None:
        self.endpoint = _validate_endpoint(endpoint)
        self.token_file = Path(token_file)
        self.timeout_seconds = _validate_timeout(timeout_seconds)
        self.max_response_bytes = _validate_response_limit(max_response_bytes)
        self._request_id = 0

    def blob_for(self, requester: Requester) -> str:
        if requester.status != "resolved":
            raise ChannelAuthorizationError("QDM 渠道授权不可用或被拒绝")
        started = time.monotonic()
        try:
            token = _read_token(self.token_file)
            self._request_id += 1
            request_id = self._request_id
            self._rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "qdm-harness-qwenpaw", "version": "1"}}, token, request_id)
            payload = self._rpc(
                "tools/call",
                {"name": "qdm_auth_lookup_blob", "arguments": {"channel": requester.channel, "user_id": requester.user_id}},
                token,
                request_id + 1,
            )
            data = _extract_payload(payload)
            blob = _validate_payload(data, requester)
            logger.debug(
                "qdm_runtime_mcp_lookup_ok channel=%s user_id_hash=%s elapsed_ms=%d",
                _safe_label(requester.channel), _user_id_hash(requester.user_id), int((time.monotonic() - started) * 1000),
            )
            return blob
        except ChannelAuthorizationError:
            raise
        except Exception as exc:
            code = _error_code(exc)
            logger.warning(
                "qdm_runtime_mcp_lookup_failed channel=%s user_id_hash=%s error_code=%s elapsed_ms=%d",
                _safe_label(getattr(requester, "channel", "")), _user_id_hash(getattr(requester, "user_id", "")), code,
                int((time.monotonic() - started) * 1000),
            )
            raise ChannelAuthorizationError("QDM 渠道授权不可用或被拒绝") from None

    def _rpc(self, method: str, params: dict[str, Any], token: str, rpc_id: int) -> dict[str, Any]:
        body = json.dumps({"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params}, separators=(",", ":")).encode("utf-8")
        request = Request(
            self.endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": f"Bearer {token}",
            },
        )
        last_error: Exception | None = None
        for attempt in range(2):
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    raw = response.read(self.max_response_bytes + 1)
                    if len(raw) > self.max_response_bytes:
                        raise RuntimeMcpConfigError("response too large")
                    content_type = response.headers.get("Content-Type", "")
                    parsed = _parse_response(raw, content_type)
                    if not isinstance(parsed, dict) or parsed.get("jsonrpc") != "2.0":
                        raise RuntimeMcpConfigError("invalid json-rpc response")
                    if "error" in parsed or not isinstance(parsed.get("result"), dict):
                        raise RuntimeMcpConfigError("json-rpc error")
                    if method == "tools/call" and parsed["result"].get("isError") is True:
                        raise RuntimeMcpConfigError("tool call failed")
                    return parsed
            except HTTPError as exc:
                last_error = exc
                if exc.code not in {502, 503, 504} or attempt:
                    raise RuntimeMcpConfigError("http failure") from None
            except (TimeoutError, URLError, OSError) as exc:
                last_error = exc
                if attempt:
                    raise RuntimeMcpConfigError("transport failure") from None
            if attempt == 0:
                time.sleep(0.15)
        raise RuntimeMcpConfigError("transport failure") from last_error


def _validate_endpoint(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeMcpConfigError("endpoint is required")
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.query or parsed.fragment:
        raise RuntimeMcpConfigError("endpoint must be an http(s) MCP URL")
    if parsed.path.rstrip("/") != "/mcp":
        raise RuntimeMcpConfigError("endpoint path must be /mcp")
    return value.strip()


def _validate_timeout(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 60:
        raise RuntimeMcpConfigError("timeout_seconds is invalid")
    return value


def _validate_response_limit(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 4096 <= value <= 8 * 1024 * 1024:
        raise RuntimeMcpConfigError("max_response_bytes is invalid")
    return value


def _read_token(path: Path) -> str:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size < 1 or info.st_size > 4096:
            raise RuntimeMcpConfigError("token file is invalid")
        if os.name != "nt" and info.st_mode & 0o077:
            raise RuntimeMcpConfigError("token file permissions are invalid")
        value = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        raise RuntimeMcpConfigError("token file is unavailable") from None
    if not value or len(value.encode("utf-8")) > 4096:
        raise RuntimeMcpConfigError("token is invalid")
    return value


def _parse_response(raw: bytes, content_type: str) -> Any:
    if content_type.lower().split(";", 1)[0].strip() != "text/event-stream":
        return json.loads(raw.decode("utf-8"))
    messages: list[Any] = []
    data_lines: list[str] = []
    for line in raw.decode("utf-8").splitlines() + [""]:
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif not line.strip() and data_lines:
            try:
                messages.append(json.loads("\n".join(data_lines)))
            except json.JSONDecodeError:
                pass
            data_lines = []
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("jsonrpc") == "2.0":
            return message
    raise RuntimeMcpConfigError("SSE response has no JSON-RPC message")


def _extract_payload(response: dict[str, Any]) -> dict[str, Any]:
    result = response.get("result")
    if not isinstance(result, dict):
        raise RuntimeMcpConfigError("missing result")
    structured = result.get("structuredContent")
    text_payload: dict[str, Any] | None = None
    for item in result.get("content", []):
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
            try:
                candidate = json.loads(item["text"])
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict):
                text_payload = candidate
                break
    if structured is not None:
        if not isinstance(structured, dict):
            raise RuntimeMcpConfigError("structured content is invalid")
        if text_payload is not None and any(structured.get(k) != text_payload.get(k) for k in ("ok", "channel", "user_id", "blob")):
            raise RuntimeMcpConfigError("structured and text payload differ")
        return structured
    if text_payload is None:
        raise RuntimeMcpConfigError("missing structured payload")
    return text_payload


def _validate_payload(payload: dict[str, Any], requester: Requester) -> str:
    if payload.get("ok") is not True:
        raise RuntimeMcpConfigError("lookup not ok")
    if payload.get("channel") != requester.channel or payload.get("user_id") != requester.user_id:
        raise RuntimeMcpConfigError("identity mismatch")
    blob = payload.get("blob")
    if not isinstance(blob, str):
        raise RuntimeMcpConfigError("blob is invalid")
    blob = blob.strip()
    if not blob.startswith("qdm1enc."):
        raise RuntimeMcpConfigError("blob prefix is invalid")
    return blob


def _error_code(exc: Exception) -> str:
    message = str(exc).lower()
    if "token" in message:
        return "MCP_TOKEN_UNAVAILABLE"
    if "http" in message or "transport" in message or "url" in message:
        return "MCP_CONNECT_FAILED"
    if "identity" in message:
        return "MCP_IDENTITY_MISMATCH"
    if "blob" in message:
        return "MCP_BLOB_INVALID"
    return "MCP_PROTOCOL_INVALID"


def _safe_label(value: Any) -> str:
    text = str(value or "")
    return text if text in {"wecom", "feishu", "dingtalk"} else "other"


def _user_id_hash(value: Any) -> str:
    import hashlib

    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:16]
