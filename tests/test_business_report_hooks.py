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
DIAG_DIR = ROOT / ".claude" / "hooks" / "state" / "diagnostics"


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

    def test_posttool_records_modules_and_injects_template_after_signal(self) -> None:
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
        self.assertIn("经营分析深度报告模板", first_signal.stdout)
        self.assertIn("## Template: templates/business-overview-report.md", first_signal.stdout)
        self.assertNotIn("经营分析指标归属规范", first_signal.stdout)
        self.assertNotIn("## Spec: spec/business-report.md", first_signal.stdout)

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

    def test_business_signal_diagnostic_records_business_spec_only(self) -> None:
        session_id = "sess-business-diag"
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(ROOT)
        env["QDM_HARNESS_DIAG"] = "1"

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
            command = f'"$QDM_CMR_CLI" report business {module} --date 2026-05-20'
            if module == "tree":
                command = '"$QDM_CMR_CLI" report business tree --values --date 2026-05-20'
            run_posttool(command)
        run_posttool("python3 .claude/hooks/before-report-signal.py business-overview")

        diag_path = DIAG_DIR / f"{session_id}.jsonl"
        events = [json.loads(line) for line in diag_path.read_text(encoding="utf-8").splitlines()]
        event = events[-1]
        self.assertEqual(event["event"], "before_report_signal")
        self.assertEqual(event["report_name"], "business-overview")
        self.assertEqual(event["spec_path"], "spec/business-report.md")
        self.assertTrue(event["spec_stats"]["path"].endswith("spec/business-report.md"))
        self.assertGreater(event["spec_stats"]["bytes"], 0)
        self.assertEqual(event["template_path"], "templates/business-overview-report.md")
        self.assertTrue(event["template_stats"]["path"].endswith("templates/business-overview-report.md"))
        self.assertGreater(event["template_stats"]["bytes"], 0)
        self.assertNotIn("member-overview", event["cross_report_keyword_hits"])

    def test_signal_diagnostics_record_each_report_spec_path(self) -> None:
        cases = {
            "business-overview": (
                (
                    '"$QDM_CMR_CLI" report business overview --date 2026-05-20',
                    '"$QDM_CMR_CLI" report business indicators --date 2026-05-20',
                    '"$QDM_CMR_CLI" report business tree --values --date 2026-05-20',
                    '"$QDM_CMR_CLI" report business area --date 2026-05-20',
                    '"$QDM_CMR_CLI" report business category --date 2026-05-20',
                    '"$QDM_CMR_CLI" report business trend --date 2026-05-20',
                ),
                "spec/business-report.md",
                "templates/business-overview-report.md",
            ),
            "store-overview": (
                ('"$QDM_CMR_CLI" report store overview --date 2026-05-20 --category-type 大分类 --category 00',),
                "spec/store-report.md",
                "templates/store-overview-report.md",
            ),
            "member-overview": (
                ('"$QDM_CMR_CLI" report user overview --date 2026-05-20',),
                "spec/member-report.md",
                "templates/member-overview-report.md",
            ),
        }
        for report_name, (commands, spec_path, template_path) in cases.items():
            with self.subTest(report_name=report_name):
                session_id = f"sess-diag-{report_name}"
                env = os.environ.copy()
                env["CLAUDE_PROJECT_DIR"] = str(ROOT)
                env["QDM_HARNESS_DIAG"] = "1"
                for command in commands:
                    subprocess.run(
                        [sys.executable, str(HOOKS_DIR / "qdm-business-report-posttool.py")],
                        input=json.dumps(
                            {"session_id": session_id, "tool_name": "Bash", "tool_input": {"command": command}},
                            ensure_ascii=False,
                        ),
                        text=True,
                        capture_output=True,
                        env=env,
                        check=True,
                    )
                subprocess.run(
                    [sys.executable, str(HOOKS_DIR / "qdm-business-report-posttool.py")],
                    input=json.dumps(
                        {
                            "session_id": session_id,
                            "tool_name": "Bash",
                            "tool_input": {"command": f"python3 .claude/hooks/before-report-signal.py {report_name}"},
                        },
                        ensure_ascii=False,
                    ),
                    text=True,
                    capture_output=True,
                    env=env,
                    check=True,
                )
                diag_path = DIAG_DIR / f"{session_id}.jsonl"
                event = json.loads(diag_path.read_text(encoding="utf-8").splitlines()[-1])
                self.assertEqual(event["report_name"], report_name)
                self.assertEqual(event["spec_path"], spec_path)
                self.assertEqual(event["template_path"], template_path)

if __name__ == "__main__":
    unittest.main()
