from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "bin" / "data-harness-cli"
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
            [str(HOOK), "context", "--format", "claude-hook"],
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
        self.assertNotIn("query_type=", context)
        self.assertIn('"current_date":"2026-05-22"', context)
        self.assertIn("spec/member/index.md", context)
        self.assertIn("spec/member/report-contract.md", context)
        self.assertIn("spec/member/category-unsupported.md", context)
        self.assertIn("routing/member-overview.md", context)
        self.assertIn("playbooks/member/default-overview.md", context)
        self.assertIn("do_not_read_template_before_signal", context)
        self.assertNotIn("用户运营指标归属规范", context)
        self.assertNotIn("## Report Template", context)
        self.assertNotIn("用户运营深度报告模板", context)
        self.assertNotIn("# QDM CLI 路由规则", context)

    def test_member_sales_prompt_injects_member_context_without_query_type(self) -> None:
        context = self.run_hook("查看昨天会员销售占比情况")
        self.assertNotIn("query_type=", context)
        self.assertIn("spec/member/index.md", context)
        self.assertIn("spec/member/repurchase.md", context)
        self.assertIn("routing/member-overview.md", context)

    def test_financial_prompt_injects_company_report_context(self) -> None:
        context = self.run_hook("查看昨天的财务报表，全国，全品类")
        self.assertNotIn("query_type=", context)
        self.assertIn('"current_date":"2026-05-22"', context)
        self.assertIn("spec/financial/index.md", context)
        self.assertIn("spec/financial/report-contract.md", context)
        self.assertIn("routing/financial-overview.md", context)
        self.assertIn("playbooks/financial/default-overview.md", context)
        self.assertNotIn("财务核心指标归属规范", context)
        self.assertNotIn("## Report Template", context)
        self.assertNotIn("财务核心指标深度报告模板", context)
        self.assertNotIn("# QDM CLI 路由规则", context)

    def test_financial_explicit_date_converts_to_iso_week(self) -> None:
        context = self.run_hook("查看2026年5月20日公司报表")
        self.assertNotIn("query_type=", context)
        self.assertIn("spec/common/time-policy.md", context)
        self.assertIn("spec/financial/report-contract.md", context)

    def test_financial_prompt_wins_over_business_revenue_keyword(self) -> None:
        context = self.run_hook("查看昨天公司营业收入和费用率表现")
        self.assertNotIn("query_type=", context)
        self.assertIn("routing/financial-overview.md", context)
        self.assertNotIn("routing/business-overview.md", context)

    def test_default_does_not_write_diagnostics_or_change_stdout_shape(self) -> None:
        context = self.run_hook("查看昨天经营情况", session_id="no-diag-context")
        self.assertNotIn("query_type=", context)
        self.assertFalse((DIAG_DIR / "no-diag-context.jsonl").exists())

    def test_business_context_diagnostic_uses_context_discovery_fields(self) -> None:
        self.run_hook("查看昨天经营情况", diag=True, session_id="diag-business-context")
        diag_path = DIAG_DIR / "diag-business-context.jsonl"
        events = [json.loads(line) for line in diag_path.read_text(encoding="utf-8").splitlines()]
        event = events[-1]
        self.assertEqual(event["event"], "user_prompt_context")
        self.assertNotIn("report_name", event)
        self.assertNotIn("injected_files", event)
        self.assertEqual(event["matched_domains"], ["business"])
        context_paths = [item["relative_path"] for item in event["context_files"]]
        self.assertIn("spec/common/cmr-cli-readme.md", context_paths)
        self.assertIn("spec/common/time-policy.md", context_paths)
        self.assertIn("routing/business-overview.md", context_paths)
        self.assertIn("spec/business/report-contract.md", context_paths)
        self.assertNotIn("routing/qdm-cli-routing.md", context_paths)
        self.assertNotIn("spec/store/report-contract.md", context_paths)
        self.assertNotIn("spec/member/report-contract.md", context_paths)
        self.assertNotIn("templates/business-overview-report.md", context_paths)
        routing = next(item for item in event["context_files"] if item["relative_path"] == "routing/business-overview.md")
        self.assertGreater(routing["bytes"], 0)

    def test_business_prompt_injects_spec_without_template_or_global_routing(self) -> None:
        context = self.run_hook("查看昨天经营情况")
        self.assertIn("spec/business/index.md", context)
        self.assertIn("spec/business/report-contract.md", context)
        self.assertIn("routing/business-overview.md", context)
        self.assertIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("经营分析指标归属规范", context)
        self.assertNotIn("经营分析深度报告模板", context)
        self.assertNotIn("# QDM CLI 路由规则", context)

    def test_store_profit_context_does_not_return_member_spec(self) -> None:
        context = self.run_hook("查看昨天门店净利润情况")
        self.assertNotIn("query_type=", context)
        self.assertIn("spec/store/profit-efficiency.md", context)
        self.assertNotIn("spec/member/index.md", context)

    def test_prompt_can_recall_multiple_domains(self) -> None:
        context = self.run_hook("会员复购和门店净利润最近为什么下降？")
        self.assertIn("spec/member/repurchase.md", context)
        self.assertIn("spec/store/profit-efficiency.md", context)
        self.assertIn("routing/member-overview.md", context)
        self.assertIn("routing/store-overview.md", context)
        self.assertNotIn("query_type=", context)

    def test_hook_does_not_output_full_spec_body(self) -> None:
        context = self.run_hook("查看昨天会员复购情况")
        self.assertIn("spec/member/repurchase.md", context)
        self.assertNotIn("会员复购率、消费会员数、复购会员数", context)
        self.assertNotIn("# 用户运营指标归属规范", context)


if __name__ == "__main__":
    unittest.main()
