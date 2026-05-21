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


hooks = load_module("business_report_hooks", HOOKS_DIR / "business_report_hooks.py")


class BusinessReportHookTests(unittest.TestCase):
    def tearDown(self) -> None:
        if STATE_DIR.exists():
            shutil.rmtree(STATE_DIR.parent, ignore_errors=True)

    def test_extract_business_module(self) -> None:
        parallel_command = """
        source config/qdm-cli-paths.env
        "$QDM_CMR_CLI" report business overview --date 2026-05-20 --ai &
        "$QDM_CMR_CLI" report business indicators --date 2026-05-20 --ai &
        "$QDM_CMR_CLI" report business tree --values --date 2026-05-20 &
        "$QDM_CMR_CLI" report business area --date 2026-05-20 --ai &
        "$QDM_CMR_CLI" report business category --date 2026-05-20 --ai &
        "$QDM_CMR_CLI" report business trend --date 2026-05-20 --ai &
        wait
        """
        self.assertEqual(
            hooks.extract_business_modules(parallel_command),
            ["overview", "indicators", "tree", "area", "category", "trend"],
        )
        self.assertEqual(
            hooks.extract_business_module(
                'source config/qdm-cli-paths.env && "$QDM_CMR_CLI" report business tree --values --date 2026-05-20'
            ),
            "tree",
        )
        self.assertEqual(
            hooks.extract_business_module(
                'source config/qdm-cli-paths.env && "$QDM_CMR_CLI" report business overview --date 2026-05-20 --ai'
            ),
            "overview",
        )
        self.assertEqual(
            hooks.extract_business_modules(
                'source config/qdm-cli-paths.env && "$QDM_CMR_CLI" report business overview --date 2026-05-20 --ai'
            ),
            ["overview"],
        )
        self.assertIsNone(hooks.extract_business_module("echo hello"))
        self.assertEqual(hooks.extract_business_modules("echo hello"), [])

    def test_posttool_records_parallel_business_modules(self) -> None:
        session_id = "sess-parallel"
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(ROOT)
        command = """
        source config/qdm-cli-paths.env
        "$QDM_CMR_CLI" report business overview --date 2026-05-20 --ai &
        "$QDM_CMR_CLI" report business indicators --date 2026-05-20 --ai &
        "$QDM_CMR_CLI" report business tree --values --date 2026-05-20 &
        "$QDM_CMR_CLI" report business area --date 2026-05-20 --ai &
        "$QDM_CMR_CLI" report business category --date 2026-05-20 --ai &
        "$QDM_CMR_CLI" report business trend --date 2026-05-20 --ai &
        wait
        """
        payload = {
            "session_id": session_id,
            "tool_name": "Bash",
            "tool_input": {"command": command},
        }
        subprocess.run(
            [sys.executable, str(HOOKS_DIR / "qdm-business-report-posttool.py")],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )

        state_path = hooks.state_path(ROOT, session_id)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        report_state = state["reports"]["business-overview"]
        self.assertEqual(
            report_state["recorded_modules"],
            ["overview", "indicators", "tree", "area", "category", "trend"],
        )

    def test_posttool_records_modules_and_injects_spec_after_signal(self) -> None:
        session_id = "sess-1"
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

        for module in ("overview", "indicators", "tree", "area", "category", "trend"):
            command = f'"/bin/true" && "$QDM_CMR_CLI" report business {module} --date 2026-05-20'
            if module == "tree":
                command = f'"/bin/true" && "$QDM_CMR_CLI" report business tree --values --date 2026-05-20'
            run_posttool(command)

        signal = subprocess.run(
            [sys.executable, str(HOOKS_DIR / "before-report-signal.py"), "business-overview"],
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )
        self.assertEqual(signal.stdout.strip(), "QDM_BEFORE_REPORT_SIGNAL business-overview")

        first_signal = run_posttool('python3 .claude/hooks/before-report-signal.py business-overview')
        self.assertIn("经营分析指标归属规范", first_signal.stdout)

        state_path = hooks.state_path(ROOT, session_id)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        report_state = state["reports"]["business-overview"]
        self.assertTrue(report_state["spec_injected"])
        self.assertTrue(report_state["signal_seen"])
        self.assertEqual(report_state["last_signal_missing"], [])

        second_signal = run_posttool('python3 .claude/hooks/before-report-signal.py business-overview')
        self.assertIn("already satisfied", second_signal.stdout)

    def test_posttool_reports_missing_modules_before_signal(self) -> None:
        session_id = "sess-2"
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(ROOT)
        payload = {
            "session_id": session_id,
            "tool_name": "Bash",
            "tool_input": {"command": '"$QDM_CMR_CLI" report business overview --date 2026-05-20 --ai'},
        }
        subprocess.run(
            [sys.executable, str(HOOKS_DIR / "qdm-business-report-posttool.py")],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )

        signal_payload = {
            "session_id": session_id,
            "tool_name": "Bash",
            "tool_input": {"command": "python3 .claude/hooks/before-report-signal.py business-overview"},
        }
        signal = subprocess.run(
            [sys.executable, str(HOOKS_DIR / "qdm-business-report-posttool.py")],
            input=json.dumps(signal_payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )
        self.assertIn("missing modules", signal.stdout)
        self.assertIn("indicators", signal.stdout)
        self.assertIn("tree", signal.stdout)
        state_path = hooks.state_path(ROOT, session_id)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        report_state = state["reports"]["business-overview"]
        self.assertFalse(report_state["spec_injected"])
        self.assertEqual(report_state["last_signal_missing"], ["indicators", "tree", "area", "category", "trend"])

if __name__ == "__main__":
    unittest.main()
