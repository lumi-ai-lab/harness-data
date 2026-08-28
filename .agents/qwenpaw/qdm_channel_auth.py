"""Read-only channel + user ID to encrypted Blob resolution."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .qdm_identity import Requester


class ChannelAuthorizationError(RuntimeError):
    """A deliberately non-sensitive, fail-closed authorization failure."""


class ChannelAuthProvider:
    def __init__(self, auth_file: Path, max_bytes: int | None = None) -> None:
        self._auth_file = auth_file
        self._max_bytes = max_bytes

    def blob_for(self, requester: Requester) -> str:
        if requester.status != "resolved":
            raise ChannelAuthorizationError("QDM 渠道授权不可用或被拒绝")
        document = self._read_document()
        try:
            user_index = document["channelUserIndex"]
            credentials = document["credentials"]
            credential_id = user_index[requester.channel][requester.user_id]
            blob = credentials[credential_id]["ciphertext"]
        except (KeyError, TypeError):
            raise ChannelAuthorizationError("QDM 渠道授权不可用或被拒绝") from None
        if not isinstance(credential_id, str) or not isinstance(blob, str) or not blob.startswith("qdm1enc."):
            raise ChannelAuthorizationError("QDM 渠道授权不可用或被拒绝")
        return blob

    def _read_document(self) -> dict[str, Any]:
        try:
            if self._auth_file.is_symlink() or not self._auth_file.is_file():
                raise ChannelAuthorizationError("QDM 渠道授权不可用或被拒绝")
            if self._max_bytes is not None and self._auth_file.stat().st_size > self._max_bytes:
                raise ChannelAuthorizationError("QDM 渠道授权不可用或被拒绝")
            document = json.loads(self._auth_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise ChannelAuthorizationError("QDM 渠道授权不可用或被拒绝") from None
        if not isinstance(document, dict):
            raise ChannelAuthorizationError("QDM 渠道授权不可用或被拒绝")
        return document
