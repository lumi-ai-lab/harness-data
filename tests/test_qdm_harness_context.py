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
        self.assertIn("do_not_read_template_before_inject_template", context)
        self.assertIn("data-harness-cli inject-template", context)
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

    def test_brand_product_effectiveness_prompt_uses_drill_context(self) -> None:
        context = self.run_hook("查看昨天的品效情况", session_id="brand-product-effectiveness")
        self.assertIn("spec/business/brand-product-effectiveness.md", context)
        self.assertIn("routing/business-brand-product-effectiveness.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("品效下钻分析报告模板", context)

    def test_cust_penetration_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的客数渗透率情况", session_id="cust-penetration-rate")
        self.assertIn("spec/business/cust-penetration-rate/cust-penetration-rate.md", context)
        self.assertIn("routing/business-cust-penetration-rate-cust-penetration-rate.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/cust-penetration-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("客数渗透率指标分析报告模板", context)

    def test_sale_amt_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的销售额情况", session_id="sale-amt")
        self.assertIn("spec/business/cust-penetration-rate/sale-amt.md", context)
        self.assertIn("routing/business-cust-penetration-rate-sale-amt.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/sale-amt.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("销售额指标分析报告模板", context)

    def test_bf19_sale_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的19点前销售占比情况", session_id="bf19-sale-rate")
        self.assertIn("spec/business/cust-penetration-rate/bf19-sale-rate.md", context)
        self.assertIn("routing/business-cust-penetration-rate-bf19-sale-rate.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/bf19-sale-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/sale-amt.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/sale-amt-report.md", context)
        self.assertNotIn("19点前销售占比指标分析报告模板", context)

    def test_bf19_sale_weight_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的19点前销售重量情况", session_id="bf19-sale-weight")
        self.assertIn("spec/business/cust-penetration-rate/bf19-sale-weight.md", context)
        self.assertIn("routing/business-cust-penetration-rate-bf19-sale-weight.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/bf19-sale-weight.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/sale-amt.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/bf19-sale-rate.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/bf19-sale-rate-report.md", context)
        self.assertNotIn("19点前销售重量指标分析报告模板", context)

    def test_satisfied_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的订单满足率情况", session_id="satisfied-rate")
        self.assertIn("spec/business/cust-penetration-rate/satisfied-rate.md", context)
        self.assertIn("routing/business-cust-penetration-rate-satisfied-rate.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/satisfied-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/sale-amt.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/bf19-sale-rate.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/bf19-sale-weight.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/bf19-sale-rate-report.md", context)
        self.assertNotIn("订单满足率指标分析报告模板", context)

    def test_cust_num_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的客数情况", session_id="cust-num")
        self.assertIn("spec/business/cust-penetration-rate/cust-num.md", context)
        self.assertIn("routing/business-cust-penetration-rate-cust-num.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/cust-num.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("客数指标分析报告模板", context)

    def test_bf19_cust_num_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的19点前客数情况", session_id="bf19-cust-num")
        self.assertIn("spec/business/cust-penetration-rate/bf19-cust-num.md", context)
        self.assertIn("routing/business-cust-penetration-rate-bf19-cust-num.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/bf19-cust-num.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/cust-num.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/cust-num-report.md", context)
        self.assertNotIn("19点前客数指标分析报告模板", context)

    def test_bf19_category_store_cust_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的19点前PI值情况", session_id="bf19-category-store-cust-rate")
        self.assertIn("spec/business/cust-penetration-rate/bf19-category-store-cust-rate.md", context)
        self.assertIn("routing/business-cust-penetration-rate-bf19-category-store-cust-rate.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/bf19-category-store-cust-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/bf19-cust-num.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/bf19-cust-num-report.md", context)
        self.assertNotIn("19点前PI值指标分析报告模板", context)

    def test_bf19_member_repurchase_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的19点前复购率情况", session_id="bf19-member-repurchase-rate")
        self.assertIn("spec/business/cust-penetration-rate/bf19-member-repurchase-rate.md", context)
        self.assertIn("routing/business-cust-penetration-rate-bf19-member-repurchase-rate.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/bf19-member-repurchase-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/bf19-cust-num.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/bf19-category-store-cust-rate.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/bf19-category-store-cust-rate-report.md", context)
        self.assertNotIn("19点前复购率指标分析报告模板", context)

    def test_per_cust_amt_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的客单价情况", session_id="per-cust-amt")
        self.assertIn("spec/business/cust-penetration-rate/per-cust-amt.md", context)
        self.assertIn("routing/business-cust-penetration-rate-per-cust-amt.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/per-cust-amt.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("客单价指标分析报告模板", context)

    def test_bf19_per_cust_amt_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的19点前客单价情况", session_id="bf19-per-cust-amt")
        self.assertIn("spec/business/cust-penetration-rate/bf19-per-cust-amt.md", context)
        self.assertIn("routing/business-cust-penetration-rate-bf19-per-cust-amt.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/bf19-per-cust-amt.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/per-cust-amt.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/per-cust-amt-report.md", context)
        self.assertNotIn("19点前客单价指标分析报告模板", context)

    def test_bf19_avg_piece_num_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的19点前单均件数情况", session_id="bf19-avg-piece-num")
        self.assertIn("spec/business/cust-penetration-rate/bf19-avg-piece-num.md", context)
        self.assertIn("routing/business-cust-penetration-rate-bf19-avg-piece-num.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/bf19-avg-piece-num.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/bf19-per-cust-amt.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/bf19-per-cust-amt-report.md", context)
        self.assertNotIn("19点前单均件数指标分析报告模板", context)

    def test_bf19_per_piece_amt_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的19点前件单价情况", session_id="bf19-per-piece-amt")
        self.assertIn("spec/business/cust-penetration-rate/bf19-per-piece-amt.md", context)
        self.assertIn("routing/business-cust-penetration-rate-bf19-per-piece-amt.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/bf19-per-piece-amt.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/bf19-per-cust-amt.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/bf19-avg-piece-num.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/bf19-avg-piece-num-report.md", context)
        self.assertNotIn("19点前件单价指标分析报告模板", context)

    def test_full_link_store_profit_notax_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的全链路毛利率情况", session_id="full-link-profit-rate")
        self.assertIn("spec/business/cust-penetration-rate/full-link-store-profit-notax-rate.md", context)
        self.assertIn("routing/business-cust-penetration-rate-full-link-store-profit-notax-rate.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/full-link-store-profit-notax-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("全链路毛利率指标分析报告模板", context)

    def test_profit_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的门店毛利率情况", session_id="profit-rate")
        self.assertIn("spec/business/cust-penetration-rate/profit-rate.md", context)
        self.assertIn("routing/business-cust-penetration-rate-profit-rate.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/profit-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/full-link-store-profit-notax-rate.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/full-link-store-profit-notax-rate-report.md", context)
        self.assertNotIn("门店毛利率指标分析报告模板", context)

    def test_scm_store_profit_notax_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的供应链毛利率情况", session_id="scm-profit-rate")
        self.assertIn("spec/business/cust-penetration-rate/scm-store-profit-notax-rate.md", context)
        self.assertIn("routing/business-cust-penetration-rate-scm-store-profit-notax-rate.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/scm-store-profit-notax-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/full-link-store-profit-notax-rate.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/profit-rate.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/profit-rate-report.md", context)
        self.assertNotIn("供应链毛利率指标分析报告模板", context)

    def test_full_link_store_profit_amt_notax_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的全链路毛利额情况", session_id="full-link-profit-amt")
        self.assertIn("spec/business/cust-penetration-rate/full-link-store-profit-amt-notax.md", context)
        self.assertIn("routing/business-cust-penetration-rate-full-link-store-profit-amt-notax.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/full-link-store-profit-amt-notax.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/full-link-store-profit-notax-rate.md", context)
        self.assertNotIn("全链路毛利额指标分析报告模板", context)

    def test_profit_amt_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的门店毛利额情况", session_id="profit-amt")
        self.assertIn("spec/business/cust-penetration-rate/profit-amt.md", context)
        self.assertIn("routing/business-cust-penetration-rate-profit-amt.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/profit-amt.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/full-link-store-profit-amt-notax.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/full-link-store-profit-amt-notax-report.md", context)
        self.assertNotIn("门店毛利额指标分析报告模板", context)

    def test_scm_store_profit_amt_notax_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的供应链毛利额情况", session_id="scm-profit-amt")
        self.assertIn("spec/business/cust-penetration-rate/scm-store-profit-amt-notax.md", context)
        self.assertIn("routing/business-cust-penetration-rate-scm-store-profit-amt-notax.md", context)
        self.assertIn("playbooks/business/cust-penetration-rate/scm-store-profit-amt-notax.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/full-link-store-profit-amt-notax.md", context)
        self.assertNotIn("playbooks/business/cust-penetration-rate/profit-amt.md", context)
        self.assertNotIn("templates/business/cust-penetration-rate/profit-amt-report.md", context)
        self.assertNotIn("供应链毛利额指标分析报告模板", context)

    def test_pre_price_profit_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的定价毛利率情况", session_id="pre-price-profit-rate")
        self.assertIn("spec/business/brand-product-effectiveness/pre-price-profit-rate.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-pre-price-profit-rate.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/pre-price-profit-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness.md", context)
        self.assertNotIn("定价毛利率指标分析报告模板", context)

    def test_pre_profit_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的预期毛利率情况", session_id="pre-profit-rate")
        self.assertIn("spec/business/brand-product-effectiveness/pre-profit-rate.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-pre-profit-rate.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/pre-profit-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/pre-price-profit-rate.md", context)
        self.assertNotIn("templates/business/brand-product-effectiveness/pre-price-profit-rate-report.md", context)
        self.assertNotIn("预期毛利率指标分析报告模板", context)

    def test_scm_promotion_total_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的出库折让率情况", session_id="scm-promotion-total-rate")
        self.assertIn("spec/business/brand-product-effectiveness/scm-promotion-total-rate.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-scm-promotion-total-rate.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/scm-promotion-total-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/pre-profit-rate.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/pre-price-profit-rate.md", context)
        self.assertNotIn("templates/business/brand-product-effectiveness/pre-profit-rate-report.md", context)
        self.assertNotIn("出库折让率指标分析报告模板", context)

    def test_hour_discount_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的时段折扣率情况", session_id="hour-discount-rate")
        self.assertIn("spec/business/brand-product-effectiveness/hour-discount-rate.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-hour-discount-rate.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/hour-discount-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/pre-price-profit-rate.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/promotion-discount-rate.md", context)
        self.assertNotIn("templates/business/brand-product-effectiveness/pre-price-profit-rate-report.md", context)
        self.assertNotIn("时段折扣率指标分析报告模板", context)

    def test_promotion_discount_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的促销折扣率情况", session_id="promotion-discount-rate")
        self.assertIn("spec/business/brand-product-effectiveness/promotion-discount-rate.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-promotion-discount-rate.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/promotion-discount-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/pre-price-profit-rate.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/hour-discount-rate.md", context)
        self.assertNotIn("templates/business/brand-product-effectiveness/pre-price-profit-rate-report.md", context)
        self.assertNotIn("促销折扣率指标分析报告模板", context)

    def test_order_article_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的商品订购渗透率情况", session_id="order-article-rate")
        self.assertIn("spec/business/brand-product-effectiveness/order-article-rate.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-order-article-rate.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/order-article-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness.md", context)
        self.assertNotIn("商品订购渗透率指标分析报告模板", context)

    def test_order_stores_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的订购门店数情况", session_id="order-stores")
        self.assertIn("spec/business/brand-product-effectiveness/order-stores.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-order-stores.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/order-stores.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/order-article-rate.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness.md", context)
        self.assertNotIn("订购门店数指标分析报告模板", context)

    def test_store_can_orders_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的可订门店数情况", session_id="store-can-orders")
        self.assertIn("spec/business/brand-product-effectiveness/store-can-orders.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-store-can-orders.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/store-can-orders.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/order-article-rate.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/order-stores.md", context)
        self.assertNotIn("templates/business/brand-product-effectiveness/order-stores-report.md", context)
        self.assertNotIn("可订门店数指标分析报告模板", context)

    def test_price_index_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的售价价格指数(线上)情况", session_id="price-index")
        self.assertIn("spec/business/brand-product-effectiveness/price-index.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-price-index.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/price-index.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness.md", context)
        self.assertNotIn("售价价格指数指标分析报告模板", context)

    def test_purchase_price_index_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的采购价格指数情况", session_id="purchase-price-index")
        self.assertIn("spec/business/brand-product-effectiveness/purchase-price-index.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-purchase-price-index.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/purchase-price-index.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/price-index.md", context)
        self.assertNotIn("templates/business/brand-product-effectiveness/price-index-report.md", context)
        self.assertNotIn("采购价格指数指标分析报告模板", context)

    def test_lost_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的损耗率情况", session_id="lost-rate")
        self.assertIn("spec/business/brand-product-effectiveness/lost-rate.md", context)
        self.assertIn("routing/business-brand-product-effectiveness-lost-rate.md", context)
        self.assertIn("playbooks/business/brand-product-effectiveness/lost-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/brand-product-effectiveness/pre-price-profit-rate.md", context)
        self.assertNotIn("损耗率指标分析报告模板", context)

    def test_active_vender_num_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的活跃供应商数情况", session_id="active-vender-num")
        self.assertIn("spec/business/active-vender-num/active-vender-num.md", context)
        self.assertIn("routing/business-active-vender-num-active-vender-num.md", context)
        self.assertIn("playbooks/business/active-vender-num/active-vender-num.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("活跃供应商数指标分析报告模板", context)

    def test_central_instock_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的集采入库占比情况", session_id="central-instock-rate")
        self.assertIn("spec/business/active-vender-num/central-instock-rate.md", context)
        self.assertIn("routing/business-active-vender-num-central-instock-rate.md", context)
        self.assertIn("playbooks/business/active-vender-num/central-instock-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/active-vender-num/active-vender-num.md", context)
        self.assertNotIn("集采入库占比指标分析报告模板", context)

    def test_three_rate_score_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的三率综合得分情况", session_id="three-rate-score")
        self.assertIn("spec/business/active-vender-num/three-rate-score.md", context)
        self.assertIn("routing/business-active-vender-num-three-rate-score.md", context)
        self.assertIn("playbooks/business/active-vender-num/three-rate-score.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/active-vender-num/active-vender-num.md", context)
        self.assertNotIn("三率综合得分指标分析报告模板", context)

    def test_vendor_accuracy_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的准确率情况", session_id="vendor-accuracy-rate")
        self.assertIn("spec/business/active-vender-num/vendor-accuracy-rate.md", context)
        self.assertIn("routing/business-active-vender-num-vendor-accuracy-rate.md", context)
        self.assertIn("playbooks/business/active-vender-num/vendor-accuracy-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/active-vender-num/three-rate-score.md", context)
        self.assertNotIn("templates/business/active-vender-num/three-rate-score-report.md", context)
        self.assertNotIn("准确率指标分析报告模板", context)

    def test_vendor_intime_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的准点率情况", session_id="vendor-intime-rate")
        self.assertIn("spec/business/active-vender-num/vendor-intime-rate.md", context)
        self.assertIn("routing/business-active-vender-num-vendor-intime-rate.md", context)
        self.assertIn("playbooks/business/active-vender-num/vendor-intime-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/active-vender-num/three-rate-score.md", context)
        self.assertNotIn("playbooks/business/active-vender-num/vendor-accuracy-rate.md", context)
        self.assertNotIn("templates/business/active-vender-num/three-rate-score-report.md", context)
        self.assertNotIn("准点率指标分析报告模板", context)

    def test_vendor_qualification_rate_prompt_uses_metric_context(self) -> None:
        context = self.run_hook("查看昨天的合格率情况", session_id="vendor-qualification-rate")
        self.assertIn("spec/business/active-vender-num/vendor-qualification-rate.md", context)
        self.assertIn("routing/business-active-vender-num-vendor-qualification-rate.md", context)
        self.assertIn("playbooks/business/active-vender-num/vendor-qualification-rate.md", context)
        self.assertNotIn("playbooks/business/default-overview.md", context)
        self.assertNotIn("playbooks/business/active-vender-num/three-rate-score.md", context)
        self.assertNotIn("playbooks/business/active-vender-num/vendor-accuracy-rate.md", context)
        self.assertNotIn("playbooks/business/active-vender-num/vendor-intime-rate.md", context)
        self.assertNotIn("templates/business/active-vender-num/three-rate-score-report.md", context)
        self.assertNotIn("合格率指标分析报告模板", context)

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
