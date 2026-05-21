from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOOKS_DIR = ROOT / ".claude" / "hooks"
STATE_DIR = ROOT / ".claude" / "hooks" / "state" / "business-report"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hooks = load_module("store_report_hooks", HOOKS_DIR / "business_report_hooks.py")


class StoreReportHookTests(unittest.TestCase):
    def tearDown(self) -> None:
        if STATE_DIR.exists():
            shutil.rmtree(STATE_DIR.parent, ignore_errors=True)

    def test_extract_store_module(self) -> None:
        command = (
            'source config/qdm-cli-paths.env && "$QDM_CMR_CLI" report store overview '
            "--date 2026-05-21 --area-type 管理区域 --area CN00 "
            "--category-type 大分类 --category 00 --ai"
        )
        self.assertEqual(hooks.extract_report_modules(command, "store-overview"), ["overview"])
        self.assertEqual(hooks.extract_report_modules(command, "business-overview"), [])
        self.assertEqual(hooks.extract_signal_report("python3 .claude/hooks/before-report-signal.py store-overview"), "store-overview")

    def test_posttool_records_store_overview_and_injects_spec_after_signal(self) -> None:
        session_id = "sess-store-1"
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(ROOT)

        def run_posttool(command: str) -> subprocess.CompletedProcess[str]:
            payload = {
                "session_id": session_id,
                "tool_name": "Bash",
                "tool_input": {"command": command},
            }
            return subprocess.run(
                [sys.executable, str(HOOKS_DIR / "qdm-business-report-posttool.py")],
                input=json.dumps(payload, ensure_ascii=False),
                text=True,
                capture_output=True,
                env=env,
                check=True,
            )

        run_posttool(
            '"$QDM_CMR_CLI" report store overview --date 2026-05-21 '
            "--area-type 管理区域 --area CN00 --category-type 大分类 --category 00 --ai"
        )

        signal = subprocess.run(
            [sys.executable, str(HOOKS_DIR / "before-report-signal.py"), "store-overview"],
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )
        self.assertEqual(signal.stdout.strip(), "QDM_BEFORE_REPORT_SIGNAL store-overview")

        first_signal = run_posttool("python3 .claude/hooks/before-report-signal.py store-overview")
        self.assertIn("门店管理指标归属规范", first_signal.stdout)

        state_path = hooks.state_path(ROOT, session_id)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        report_state = state["reports"]["store-overview"]
        self.assertEqual(report_state["recorded_modules"], ["overview"])
        self.assertTrue(report_state["spec_injected"])
        self.assertTrue(report_state["signal_seen"])
        self.assertEqual(report_state["last_signal_missing"], [])

    def test_posttool_reports_missing_store_overview_before_signal(self) -> None:
        session_id = "sess-store-2"
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(ROOT)
        payload = {
            "session_id": session_id,
            "tool_name": "Bash",
            "tool_input": {"command": "python3 .claude/hooks/before-report-signal.py store-overview"},
        }
        signal = subprocess.run(
            [sys.executable, str(HOOKS_DIR / "qdm-business-report-posttool.py")],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )
        self.assertIn("missing modules", signal.stdout)
        self.assertIn("overview", signal.stdout)

        state_path = hooks.state_path(ROOT, session_id)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        report_state = state["reports"]["store-overview"]
        self.assertFalse(report_state["spec_injected"])
        self.assertEqual(report_state["last_signal_missing"], ["overview"])


if __name__ == "__main__":
    unittest.main()
