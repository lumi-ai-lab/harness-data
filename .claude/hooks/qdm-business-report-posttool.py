#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys

from business_report_hooks import (
    REPORT_NAME,
    extract_business_modules,
    get_report_state,
    load_state,
    missing_modules,
    record_module,
    resolve_project_dir,
    save_state,
)


def build_output(message: str) -> None:
    sys.stdout.write(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": message,
                }
            },
            ensure_ascii=False,
        )
    )
    sys.stdout.write("\n")


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0
    if not isinstance(payload, dict):
        return 0

    tool_name = payload.get("tool_name")
    if tool_name != "Bash":
        return 0

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0

    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return 0

    session_id = str(payload.get("session_id") or os.environ.get("CLAUDE_SESSION_ID") or "unknown")
    project_dir = resolve_project_dir()
    state = load_state(project_dir, session_id)
    report_state = get_report_state(state, REPORT_NAME)

    modules = extract_business_modules(command)
    if modules:
        changed = False
        for module in modules:
            changed = record_module(state, module) or changed
        if changed:
            save_state(project_dir, session_id, state)
        return 0

    normalized = " ".join(command.split())
    if "before-report-signal.py business-overview" not in normalized:
        return 0

    report_state["signal_seen"] = True
    report_state["last_signal_command"] = normalized
    missing = missing_modules(report_state)
    report_state["last_signal_missing"] = missing

    if report_state.get("spec_injected"):
        save_state(project_dir, session_id, state)
        build_output(
            "business-overview signal already satisfied in this session; do not request spec injection again."
        )
        return 0

    if missing:
        save_state(project_dir, session_id, state)
        build_output(
            "QDM_BEFORE_REPORT_SIGNAL business-overview missing modules: "
            + ", ".join(missing)
            + ". Continue querying the missing modules, then rerun python3 .claude/hooks/before-report-signal.py business-overview."
        )
        return 0

    report_path = project_dir / "spec" / "business-report.md"
    if not report_path.is_file():
        save_state(project_dir, session_id, state)
        build_output("QDM_BEFORE_REPORT_SIGNAL business-overview missing spec/business-report.md.")
        return 0

    report_state["spec_injected"] = True
    save_state(project_dir, session_id, state)
    build_output(report_path.read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
