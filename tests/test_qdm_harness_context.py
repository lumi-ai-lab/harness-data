from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / ".claude" / "hooks" / "qdm-harness-context.py"
DIAG_DIR = ROOT / ".claude" / "hooks" / "state" / "diagnostics"


class QdmHarnessContextTests(unittest.TestCase):
    def tearDown(self) -> None:
        if DIAG_DIR.exists():
            shutil.rmtree(DIAG_DIR, ignore_errors=True)

    def run_hook(self, prompt: str, *, diag: bool = False, session_id: str = "test-context") -> str:
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(ROOT)
        env["QDM_HARNESS_CURRENT_DATE"] = "2026-05-22"
        env["CLAUDE_SESSION_ID"] = session_id
        if diag:
            env["QDM_HARNESS_DIAG"] = "1"
        else:
            env.pop("QDM_HARNESS_DIAG", None)
        result = subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps({"prompt": prompt}, ensure_ascii=False),
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )
        payload = json.loads(result.stdout)
        return payload["hookSpecificOutput"]["additionalContext"]

    def test_member_prompt_injects_user_report_context_without_category_filter(self) -> None:
        context = self.run_hook("查看昨天用户情况，全国，全品类维度")
        self.assertIn("query_type=member_overview", context)
        self.assertIn("report=user", context)
        self.assertIn("report user overview <time_filter> --area-type 管理区域 --area CN00 --ai", context)
        self.assertIn("before-report-signal.py member-overview", context)
        self.assertIn("用户运营深度报告 Playbook", context)
        self.assertIn('"current_date":"2026-05-22"', context)
        self.assertIn('"default_area_filter":"--area-type 管理区域 --area CN00"', context)
        self.assertIn('"category_supported":false', context)
        self.assertIn("# CMR CLI 使用说明", context)
        self.assertIn("# QDM 时间口径规则", context)
        self.assertIn("# 用户运营深度报告路由", context)
        self.assertIn("用户运营指标归属规范", context)
        self.assertNotIn("## Report Template", context)
        self.assertNotIn("用户运营深度报告模板", context)
        self.assertNotIn("# QDM CLI 路由规则", context)

    def test_member_prompt_wins_over_business_sales_keyword(self) -> None:
        context = self.run_hook("查看昨天会员销售占比情况")
        context_header = context.split("## Intent Spec", 1)[0]
        self.assertIn("query_type=member_overview", context_header)
        self.assertNotIn("query_type=business_overview", context_header)

    def test_financial_prompt_injects_company_report_context(self) -> None:
        context = self.run_hook("查看昨天的财务报表，全国，全品类")
        self.assertIn("query_type=financial_overview", context)
        self.assertIn("report=company", context)
        self.assertIn("report company indicators <time_filter> --ai", context)
        self.assertIn("report company tree --values <time_filter>", context)
        self.assertIn("table --report company <time_filter> --indicator EBITDA --dim-type 管理区域 --ai", context)
        self.assertIn("before-report-signal.py financial-overview", context)
        self.assertIn("财务核心指标深度报告 Playbook", context)
        self.assertIn('"current_date":"2026-05-22"', context)
        self.assertIn('"time_requirement":"company reports use --week or --month only; convert date questions to the containing ISO week."', context)
        self.assertIn('"category_supported":false', context)
        self.assertNotIn('"cli_filter"', context)
        self.assertIn("# 财务核心指标深度报告路由", context)
        self.assertIn("财务核心指标归属规范", context)
        self.assertNotIn("## Report Template", context)
        self.assertNotIn("财务核心指标深度报告模板", context)
        self.assertNotIn("# QDM CLI 路由规则", context)

    def test_financial_explicit_date_converts_to_iso_week(self) -> None:
        context = self.run_hook("查看2026年5月20日公司报表")
        self.assertIn("query_type=financial_overview", context)
        self.assertNotIn('"cli_filter"', context)
        self.assertIn("company 报表只能使用 `--week` 或 `--month`", context)
        self.assertIn("公司/财务报表不支持日维度", context)

    def test_financial_prompt_wins_over_business_revenue_keyword(self) -> None:
        context = self.run_hook("查看昨天公司营业收入和费用率表现")
        context_header = context.split("## Intent Spec", 1)[0]
        self.assertIn("query_type=financial_overview", context_header)
        self.assertNotIn("query_type=business_overview", context_header)

    def test_default_does_not_write_diagnostics_or_change_stdout_shape(self) -> None:
        context = self.run_hook("查看昨天经营情况", session_id="no-diag-context")
        self.assertIn("query_type=business_overview", context)
        self.assertFalse((DIAG_DIR / "no-diag-context.jsonl").exists())

    def test_business_context_diagnostic_uses_single_report_routing(self) -> None:
        self.run_hook("查看昨天经营情况", diag=True, session_id="diag-business-context")
        diag_path = DIAG_DIR / "diag-business-context.jsonl"
        events = [json.loads(line) for line in diag_path.read_text(encoding="utf-8").splitlines()]
        event = events[-1]
        self.assertEqual(event["event"], "user_prompt_context")
        self.assertEqual(event["report_name"], "business-overview")
        injected_paths = [item["relative_path"] for item in event["injected_files"]]
        self.assertIn("spec/cmr-cli-readme.md", injected_paths)
        self.assertIn("spec/qdm-time-policy.md", injected_paths)
        self.assertIn("routing/business-overview.md", injected_paths)
        self.assertIn("spec/business-report.md", injected_paths)
        self.assertNotIn("routing/qdm-cli-routing.md", injected_paths)
        self.assertNotIn("spec/store-report.md", injected_paths)
        self.assertNotIn("spec/member-report.md", injected_paths)
        self.assertNotIn("templates/business-overview-report.md", injected_paths)
        routing = next(item for item in event["injected_files"] if item["relative_path"] == "routing/business-overview.md")
        self.assertGreater(routing["bytes"], 0)
        self.assertEqual(routing["cross_report_keyword_hits"], {})

    def test_business_prompt_injects_spec_without_template_or_global_routing(self) -> None:
        context = self.run_hook("查看昨天经营情况")
        self.assertIn("经营分析指标归属规范", context)
        self.assertIn("spec 已在取数前注入", context)
        self.assertIn("signal 前不注入 template", context)
        self.assertIn("下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py business-overview`", context)
        self.assertIn("禁止总结、禁止整理报告素材、禁止生成中间分析", context)
        self.assertNotIn("经营分析深度报告模板", context)
        self.assertNotIn("# QDM CLI 路由规则", context)


if __name__ == "__main__":
    unittest.main()
