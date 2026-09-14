#!/usr/bin/env python3
"""Fail-closed, non-sensitive Runtime MCP deployment preflight."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import stat
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_ENDPOINT = "http://qdm-auth-center:8765/mcp"
DEFAULT_TOKEN_FILE = "/run/secrets/qdm-auth-runtime.token"


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--endpoint", default=os.environ.get("QDM_RUNTIME_MCP_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument("--token-file", default=DEFAULT_TOKEN_FILE)
    parser.add_argument("--timeout-seconds", type=int, default=8)
    args = parser.parse_args()
    try:
        if not 1 <= args.timeout_seconds <= 60:
            raise ValueError("timeout is invalid")
        token = read_token(Path(args.token_file))
        initialize = rpc(args.endpoint, token, 1, "initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "qwenpaw-runtime-mcp-preflight", "version": "1"},
        }, args.timeout_seconds)
        if not isinstance(initialize.get("result"), dict):
            raise ValueError("initialize response is invalid")
        listed = rpc(args.endpoint, token, 2, "tools/list", {}, args.timeout_seconds)
        tools = listed.get("result", {}).get("tools") if isinstance(listed.get("result"), dict) else None
        if not isinstance(tools, list) or "qdm_auth_lookup_blob" not in {
            item.get("name") for item in tools if isinstance(item, dict)
        }:
            raise ValueError("required runtime tool is unavailable")
    except (OSError, UnicodeError, ValueError, HTTPError, URLError, json.JSONDecodeError):
        # Do not include request bodies, tokens, response content, or exception
        # strings because those can be supplied by external infrastructure.
        print("Runtime MCP preflight failed", file=sys.stderr)
        return 1
    print("Runtime MCP preflight passed")
    return 0


def read_token(path: Path) -> str:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size < 1 or info.st_size > 4096:
        raise ValueError("token file is invalid")
    if os.name != "nt" and info.st_mode & 0o077:
        raise ValueError("token file permissions are invalid")
    token = path.read_text(encoding="utf-8").strip()
    if not token or len(token.encode("utf-8")) > 4096:
        raise ValueError("token is invalid")
    return token


def rpc(endpoint: str, token: str, request_id: int, method: str, params: dict[str, Any], timeout: int) -> dict[str, Any]:
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}, separators=(",", ":")).encode()
    request = Request(endpoint, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
    })
    with urlopen(request, timeout=timeout) as response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("response is too large")
        parsed = parse_response(raw, response.headers.get("Content-Type", ""))
    if not isinstance(parsed, dict) or parsed.get("jsonrpc") != "2.0" or parsed.get("error") is not None:
        raise ValueError("JSON-RPC response is invalid")
    return parsed


def parse_response(raw: bytes, content_type: str) -> Any:
    if content_type.lower().split(";", 1)[0].strip() != "text/event-stream":
        return json.loads(raw.decode("utf-8"))
    messages: list[Any] = []
    for line in raw.decode("utf-8").splitlines():
        if line.startswith("data:"):
            try:
                messages.append(json.loads(line[5:].lstrip()))
            except json.JSONDecodeError:
                continue
    if not messages:
        raise ValueError("SSE response is invalid")
    return messages[-1]


if __name__ == "__main__":
    raise SystemExit(main())
