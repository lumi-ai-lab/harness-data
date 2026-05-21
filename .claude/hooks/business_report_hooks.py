#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

REPORT_NAME = "business-overview"
REQUIRED_MODULES = ("overview", "indicators", "tree", "area", "category", "trend")


def resolve_project_dir() -> Path:
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if project_dir:
        return Path(project_dir)
    return Path(__file__).resolve().parents[2]


def resolve_harness_dir(project_dir: Path) -> Path:
    if (project_dir / "intents").is_dir() and (project_dir / "routing").is_dir():
        return project_dir
    nested = project_dir / "harness-data"
    if (nested / "intents").is_dir() and (nested / "routing").is_dir():
        return nested
    return project_dir


def state_dir(project_dir: Path) -> Path:
    return project_dir / ".claude" / "hooks" / "state" / "business-report"


def state_path(project_dir: Path, session_id: str) -> Path:
    safe_session = re.sub(r"[^A-Za-z0-9_.-]+", "_", session_id) or "unknown"
    return state_dir(project_dir) / f"{safe_session}.json"


def parse_json_payload(raw: str) -> dict[str, Any]:
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def normalize_command(command: str) -> str:
    return re.sub(r"\s+", " ", command.strip())


def extract_business_modules(command: str) -> list[str]:
    normalized = normalize_command(command)
    lowered = normalized.lower()
    matches = list(
        re.finditer(
            r"\breport\s+business\s+(overview|indicators|tree|area|category|trend)\b",
            lowered,
        )
    )
    modules: list[str] = []
    for index, match in enumerate(matches):
        module = match.group(1)
        segment_end = matches[index + 1].start() if index + 1 < len(matches) else len(lowered)
        segment = lowered[match.start() : segment_end]
        if module == "tree" and "--values" not in segment:
            continue
        if module not in modules:
            modules.append(module)
    return modules


def extract_business_module(command: str) -> str | None:
    modules = extract_business_modules(command)
    return modules[0] if modules else None


def load_state(project_dir: Path, session_id: str) -> dict[str, Any]:
    path = state_path(project_dir, session_id)
    if not path.is_file():
        return {"session_id": session_id, "reports": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"session_id": session_id, "reports": {}}
    if not isinstance(payload, dict):
        return {"session_id": session_id, "reports": {}}
    payload.setdefault("session_id", session_id)
    reports = payload.get("reports")
    if not isinstance(reports, dict):
        payload["reports"] = {}
    return payload


def save_state(project_dir: Path, session_id: str, payload: dict[str, Any]) -> None:
    directory = state_dir(project_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = state_path(project_dir, session_id)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=directory, encoding="utf-8") as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=2, sort_keys=True)
        tmp.write("\n")
        temp_path = Path(tmp.name)
    temp_path.replace(path)


def get_report_state(payload: dict[str, Any], report_name: str = REPORT_NAME) -> dict[str, Any]:
    reports = payload.setdefault("reports", {})
    report_state = reports.get(report_name)
    if not isinstance(report_state, dict):
        report_state = {
            "recorded_modules": [],
            "signal_seen": False,
            "spec_injected": False,
            "last_signal_missing": [],
            "last_signal_command": "",
        }
        reports[report_name] = report_state
    report_state.setdefault("recorded_modules", [])
    report_state.setdefault("signal_seen", False)
    report_state.setdefault("spec_injected", False)
    report_state.setdefault("last_signal_missing", [])
    report_state.setdefault("last_signal_command", "")
    return report_state


def record_module(payload: dict[str, Any], module: str) -> bool:
    report_state = get_report_state(payload)
    modules = report_state.setdefault("recorded_modules", [])
    if module in modules:
        return False
    modules.append(module)
    return True


def missing_modules(report_state: dict[str, Any]) -> list[str]:
    recorded = set(report_state.get("recorded_modules", []))
    return [module for module in REQUIRED_MODULES if module not in recorded]
