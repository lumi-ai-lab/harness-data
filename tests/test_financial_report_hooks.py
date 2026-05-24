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


hooks = load_module("financial_report_hooks", HOOKS_DIR / "business_report_hooks.py")


class FinancialReportHookTests(unittest.TestCase):
    def tearDown(self) -> None:
        if STATE_DIR.exists():
            shutil.rmtree(STATE_DIR.parent, ignore_errors=True)

    def test_extract_financial_module(self) -> None:
        indicators_command = (
            'source config/qdm-cli-paths.env && "$QDM_CMR_CLI" report company indicators '
            "--week 2026-W21 --ai"
        )
        tree_command = (
            'source config/qdm-cli-paths.env && "$QDM_CMR_CLI" report company tree --values '
            "--week 2026-W21"
        )
        table_command = (
            'source config/qdm-cli-paths.env && "$QDM_CMR_CLI" table --report company '
            "--week 2026-W21 --indicator EBITDA --dim-type 管理区域 --ai"
        )
        self.assertEqual(hooks.extract_report_modules(indicators_command, "financial-overview"), ["indicators"])
        self.assertEqual(hooks.extract_report_modules(tree_command, "financial-overview"), ["tree"])
        self.assertEqual(hooks.extract_report_modules(table_command, "financial-overview"), ["table"])
        self.assertEqual(hooks.extract_report_modules(indicators_command, "business-overview"), [])
        self.assertEqual(
            hooks.extract_signal_report("python3 .claude/hooks/before-report-signal.py financial-overview"),
            "financial-overview",
        )

    def test_posttool_records_financial_overview_and_injects_template_after_signal(self) -> None:
        session_id = "sess-financial-1"
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
            '"$QDM_CMR_CLI" report company indicators --week 2026-W21 --ai'
        )
        run_posttool(
            '"$QDM_CMR_CLI" report company tree --values --week 2026-W21'
        )
        run_posttool(
            '"$QDM_CMR_CLI" table --report company --week 2026-W21 '
            "--indicator EBITDA --dim-type 管理区域 --ai"
        )

        signal = subprocess.run(
            [sys.executable, str(HOOKS_DIR / "before-report-signal.py"), "financial-overview"],
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )
        self.assertEqual(signal.stdout.strip(), "QDM_BEFORE_REPORT_SIGNAL financial-overview")

        first_signal = run_posttool("python3 .claude/hooks/before-report-signal.py financial-overview")
        self.assertIn("财务核心指标深度报告模板", first_signal.stdout)
        self.assertIn("## Template: templates/financial-overview-report.md", first_signal.stdout)
        self.assertNotIn("财务核心指标归属规范", first_signal.stdout)
        self.assertNotIn("## Spec: spec/financial-report.md", first_signal.stdout)

        state_path = hooks.state_path(ROOT, session_id)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        report_state = state["reports"]["financial-overview"]
        self.assertEqual(report_state["recorded_modules"], ["indicators", "tree", "table"])
        self.assertTrue(report_state["spec_injected"])
        self.assertTrue(report_state["signal_seen"])
        self.assertEqual(report_state["last_signal_missing"], [])

    def test_posttool_reports_missing_financial_overview_before_signal(self) -> None:
        session_id = "sess-financial-2"
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(ROOT)
        payload = {
            "session_id": session_id,
            "tool_name": "Bash",
            "tool_input": {"command": "python3 .claude/hooks/before-report-signal.py financial-overview"},
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
        self.assertIn("indicators", signal.stdout)
        self.assertIn("tree", signal.stdout)
        self.assertIn("table", signal.stdout)

        state_path = hooks.state_path(ROOT, session_id)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        report_state = state["reports"]["financial-overview"]
        self.assertFalse(report_state["spec_injected"])
        self.assertEqual(report_state["last_signal_missing"], ["indicators", "tree", "table"])


if __name__ == "__main__":
    unittest.main()
