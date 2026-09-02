#!/usr/bin/env python3
"""Run the production acceptance question through the real QwenPaw runtime."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any


DEFAULT_QUESTION = (
    "分析一下 8 月 31 日华东区 水果类的的总销售额、店均销售额、"
    "19 点前来客数、时段折损率、门店毛利额、门店毛利率"
)
TARGET_DATE = "2026-08-31"
TARGET_AREA_ID = "CN15"
TARGET_CATEGORY_ID = "12"


def _settings() -> dict[str, Any]:
    config_path = Path(os.environ.get("HARNESS_PLUGIN_CONFIG", "/etc/qdm/qwenpaw/plugin-config.json"))
    plugin_config = json.loads(config_path.read_text(encoding="utf-8"))
    context_path = Path(plugin_config["root_context_path"])
    return json.loads((context_path.parent / "config" / "settings.json").read_text(encoding="utf-8"))


def _scope_ids(scope: dict[str, Any], dimension: str) -> set[str]:
    entries = (scope.get("dataScope") or {}).get(dimension) or []
    return {
        str(entry.get("id") or "")
        for entry in entries
        if isinstance(entry, dict) and entry.get("id")
    }


def _describe_scope(metric_cli: str, blob: str) -> dict[str, Any] | None:
    env = dict(os.environ)
    env["QDM_AUTH_BLOB"] = blob
    proc = subprocess.run(
        [metric_cli, "auth", "describe", "--resolve-labels=false"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        env=env,
    )
    if proc.returncode != 0:
        return None
    try:
        value = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _select_identity(metric_cli: str) -> tuple[str, str]:
    auth_path = Path("/run/secrets/channel-auth.json")
    document = json.loads(auth_path.read_text(encoding="utf-8"))
    index = ((document.get("channelUserIndex") or {}).get("wecom") or {})
    credentials = document.get("credentials") or {}
    seen: set[str] = set()
    for user_id, credential_id in index.items():
        if not isinstance(user_id, str) or not isinstance(credential_id, str) or credential_id in seen:
            continue
        seen.add(credential_id)
        record = credentials.get(credential_id)
        blob = record.get("ciphertext") if isinstance(record, dict) else None
        if not isinstance(blob, str) or not blob.startswith("qdm1enc."):
            continue
        scope = _describe_scope(metric_cli, blob)
        if not scope or scope.get("enabled") is not True:
            continue
        if "qdm.metric.query" not in (scope.get("capabilities") or []):
            continue
        if TARGET_AREA_ID not in _scope_ids(scope, "sapArea2Id"):
            continue
        if TARGET_CATEGORY_ID not in _scope_ids(scope, "categoryLevel1Id"):
            continue
        return user_id, blob
    raise RuntimeError(
        "channel-auth.json has no WeCom identity authorized for "
        f"sapArea2Id={TARGET_AREA_ID} and categoryLevel1Id={TARGET_CATEGORY_ID}",
    )


def _dump_event(event: Any) -> dict[str, Any]:
    if hasattr(event, "model_dump"):
        value = event.model_dump(mode="json")
        return value if isinstance(value, dict) else {"value": value}
    if isinstance(event, dict):
        return event
    return {"value": str(event)}


def _text_from(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(_text_from(item) for item in value)
    if not isinstance(value, dict):
        return ""
    if isinstance(value.get("text"), str):
        return value["text"]
    return "".join(_text_from(value.get(key)) for key in ("content", "output"))


def _metric_count(response: str) -> int:
    labels = (
        "总销售额",
        "店均销售额",
        "19点前来客数",
        "19 点前来客数",
        "时段折扣率",
        "时段折损率",
        "门店毛利额",
        "门店毛利率",
    )
    matched: set[str] = set()
    canonical = {
        "19 点前来客数": "19点前来客数",
        "时段折损率": "时段折扣率",
    }
    for label in labels:
        if re.search(re.escape(label) + r"[^\d+-]{0,32}[-+]?\d", response):
            matched.add(canonical.get(label, label))
    return len(matched)


async def _run(question: str, timeout: int) -> dict[str, Any]:
    from qwenpaw.app._app import app
    from qwenpaw.schemas import AgentRequest

    settings = _settings()
    metric_cli = str(settings.get("metricCliPath") or "")
    if not metric_cli:
        raise RuntimeError("metric CLI is not configured")
    user_id, _blob = _select_identity(metric_cli)
    identity_hash = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:12]

    async with app.router.lifespan_context(app):
        manager = app.state.multi_agent_manager
        workspace = await manager.get_agent("default")
        deadline = time.monotonic() + 120
        while True:
            registry = getattr(getattr(workspace, "plugins", None), "tool_registry", None)
            if registry is not None and "qdm_query" in registry and "qdm_scope_summary" in registry:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("QDM plugin tools were not registered before the startup deadline")
            await asyncio.sleep(0.25)

        request = AgentRequest(
            input=[
                {
                    "role": "user",
                    "content": [{"type": "text", "text": question}],
                },
            ],
            session_id="qdm-qwenpaw-docker-smoke",
            user_id=user_id,
            channel="wecom",
        )
        request.channel_meta = {
            "wecom_sender_id": user_id,
            "wecom_chatid": "qdm-qwenpaw-docker-smoke",
            "wecom_chat_type": "single",
            "is_group": False,
        }

        events: list[dict[str, Any]] = []

        async def consume() -> None:
            async for event in workspace.stream_query(request):
                events.append(_dump_event(event))

        await asyncio.wait_for(consume(), timeout=timeout)

    completed = [
        event
        for event in events
        if event.get("object") == "message" and str(event.get("status", "")).lower() == "completed"
    ]
    response = "\n".join(filter(None, (_text_from(event) for event in completed))).strip()
    if not response:
        response = "\n".join(filter(None, (_text_from(event) for event in events))).strip()
    count = _metric_count(response)
    if count < 4:
        raise RuntimeError(f"QwenPaw response contained only {count} recognizable metric values: {response[:1000]}")
    return {
        "ok": True,
        "question": question,
        "targetDate": TARGET_DATE,
        "authorizedIdentityHash": identity_hash,
        "metricValueCount": count,
        "response": response,
        "eventCount": len(events),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--output", default="")
    args = parser.parse_args()
    try:
        result = asyncio.run(_run(args.question, args.timeout))
    except Exception as exc:
        print(f"QwenPaw smoke query failed: {exc}", file=sys.stderr)
        return 1
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
