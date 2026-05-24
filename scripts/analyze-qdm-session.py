#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path
from typing import Any


REPORT_KEYWORDS = {
    "business-overview": ("business-overview", "report business", "经营分析", "经营分析指标归属规范"),
    "store-overview": ("store-overview", "report store", "门店管理", "门店管理指标归属规范"),
    "member-overview": (
        "member-overview",
        "report user",
        "用户运营",
        "用户运营指标归属规范",
        "用户运营深度报告模板",
        "用户运营深度报告",
    ),
}
TEMPLATE_RE = re.compile(r"data-harness-cli\s+inject-template")
TOOL_RE = re.compile(r"\breport\s+(business|store|user)\s+([a-z]+)\b")


def parse_ts(value: object) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(normalized)
    except ValueError:
        return None


def text_from_content(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                for key in ("text", "content", "input"):
                    value = item.get(key)
                    if isinstance(value, str):
                        parts.append(value)
                    elif isinstance(value, dict):
                        parts.append(json.dumps(value, ensure_ascii=False))
        return "\n".join(parts)
    if isinstance(content, dict):
        return json.dumps(content, ensure_ascii=False)
    return ""


def event_text(payload: dict[str, Any]) -> str:
    message = payload.get("message")
    if isinstance(message, dict):
        return text_from_content(message.get("content"))
    for key in ("content", "text", "result"):
        text = text_from_content(payload.get(key))
        if text:
            return text
    return ""


def keyword_hits(text: str) -> dict[str, list[str]]:
    return {
        report: [keyword for keyword in keywords if keyword in text]
        for report, keywords in REPORT_KEYWORDS.items()
        if any(keyword in text for keyword in keywords)
    }


def json_loads_line(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"{path}:{line_no}: invalid JSON: {exc}") from exc
        if isinstance(payload, dict):
            payload["_line_no"] = line_no
            events.append(payload)
    return events


def tool_name(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("tool_name"), str):
        return str(payload["tool_name"])
    message = payload.get("message")
    content = message.get("content") if isinstance(message, dict) else payload.get("content")
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "tool_use":
                name = item.get("name")
                return str(name) if name else ""
    return ""


def tool_command(payload: dict[str, Any]) -> str:
    tool_input = payload.get("tool_input")
    if isinstance(tool_input, dict) and isinstance(tool_input.get("command"), str):
        return tool_input["command"]
    message = payload.get("message")
    content = message.get("content") if isinstance(message, dict) else payload.get("content")
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "tool_use":
                tool_input = item.get("input")
                if isinstance(tool_input, dict) and isinstance(tool_input.get("command"), str):
                    return tool_input["command"]
    return ""


def report_context_size(text: str) -> int | None:
    marker = '"additionalContext"'
    if marker not in text and "additionalContext" not in text:
        return None
    return len(text.encode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze QDM Claude session JSONL for report hook diagnostics.")
    parser.add_argument("jsonl", type=Path, help="Claude session JSONL path")
    args = parser.parse_args()

    events = json_loads_line(args.jsonl)
    previous_ts: dt.datetime | None = None
    total_bytes = 0
    print(f"# QDM session analysis: {args.jsonl}")
    print()
    print("| line | timestamp | delta_ms | kind | detail | bytes | keyword_hits |")
    print("| ---: | --- | ---: | --- | --- | ---: | --- |")
    for payload in events:
        ts = parse_ts(payload.get("timestamp") or payload.get("created_at") or payload.get("ts"))
        delta = int((ts - previous_ts).total_seconds() * 1000) if ts and previous_ts else ""
        if ts:
            previous_ts = ts
        text = event_text(payload)
        total_bytes += len(text.encode("utf-8"))
        name = tool_name(payload)
        command = tool_command(payload)
        kind = str(payload.get("type") or payload.get("hook_event_name") or payload.get("role") or "event")
        detail = ""
        if name:
            kind = f"tool:{name}"
            detail = " ".join(command.split())[:120]
        elif TEMPLATE_RE.search(text):
            kind = "template"
            detail = TEMPLATE_RE.search(text).group(0)
        elif "additionalContext" in text or "hookSpecificOutput" in text:
            kind = "hook_context"
            detail = "additionalContext"
        else:
            match = TOOL_RE.search(text)
            detail = match.group(0) if match else text.replace("\n", " ")[:120]
        size = report_context_size(text) or len(text.encode("utf-8"))
        hits = keyword_hits(text)
        print(
            "| {line} | {timestamp} | {delta} | {kind} | {detail} | {size} | {hits} |".format(
                line=payload.get("_line_no", ""),
                timestamp=ts.isoformat() if ts else "",
                delta=delta,
                kind=kind.replace("|", "\\|"),
                detail=detail.replace("|", "\\|"),
                size=size,
                hits=json.dumps(hits, ensure_ascii=False, separators=(",", ":")).replace("|", "\\|"),
            )
        )
    print()
    print(f"events={len(events)} text_bytes={total_bytes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
