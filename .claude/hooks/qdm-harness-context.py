#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from business_report_hooks import (
    cross_report_keyword_hits,
    diagnostics_enabled,
    path_stats,
    write_diagnostic_event,
)


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


def parse_prompt(raw: str) -> str:
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {}
    prompt = payload.get("prompt", "")
    return prompt if isinstance(prompt, str) else ""


BUSINESS_OVERVIEW_RE = re.compile(
    r"(经营|业务表现|整体表现|营业|销售).*(情况|分析|表现|报告|复盘|概览|怎么样)"
    r"|((情况|表现|报告|复盘|概览|怎么样).*(经营|业务表现|整体表现|营业|销售))"
)
STORE_OVERVIEW_RE = re.compile(
    r"(门店|开店|闭店|坪效|人效|门店利润|门店净利润|门店管理|门店运营|门店规模|门店健康)"
    r".*(情况|分析|表现|报告|复盘|概览|怎么样|效率|利润|规模|健康度)?"
    r"|((情况|表现|报告|复盘|概览|怎么样).*(门店|开店|闭店|坪效|人效|门店利润|门店净利润|门店管理|门店运营|门店规模|门店健康))"
)
MEMBER_OVERVIEW_RE = re.compile(
    r"(用户报表|用户运营|用户情况|用户|会员运营|会员表现|会员|活跃用户|用户留存|会员复购|用户触达)"
    r".*(情况|分析|表现|报告|复盘|概览|怎么样|留存|复购|触达)?"
    r"|((情况|表现|报告|复盘|概览|怎么样).*(用户报表|用户运营|用户|会员运营|会员表现|会员|活跃用户|用户留存|会员复购|用户触达))"
)
FINANCIAL_OVERVIEW_RE = re.compile(
    r"(财务报表|财务|公司报表|公司财务|盈利|利润|EBITDA|ebitda|营业收入|毛利额|费用率|费用额)"
    r".*(情况|分析|表现|报告|复盘|概览|怎么样|收入|毛利|费用|利润)?"
    r"|((情况|表现|报告|复盘|概览|怎么样).*(财务报表|财务|公司报表|公司财务|盈利|利润|EBITDA|ebitda|营业收入|毛利额|费用率|费用额))"
)
CONTEXT_FILES = {
    "business-overview": (
        Path("spec/cmr-cli-readme.md"),
        Path("spec/qdm-time-policy.md"),
        Path("intents/business-overview.md"),
        Path("routing/business-overview.md"),
        Path("spec/business-report.md"),
        Path("playbooks/business-overview-analysis.md"),
    ),
    "store-overview": (
        Path("spec/cmr-cli-readme.md"),
        Path("spec/qdm-time-policy.md"),
        Path("intents/store-overview.md"),
        Path("routing/store-overview.md"),
        Path("spec/store-report.md"),
        Path("playbooks/store-overview-analysis.md"),
    ),
    "member-overview": (
        Path("spec/cmr-cli-readme.md"),
        Path("spec/qdm-time-policy.md"),
        Path("intents/member-overview.md"),
        Path("routing/member-overview.md"),
        Path("spec/member-report.md"),
        Path("playbooks/member-overview-analysis.md"),
    ),
    "financial-overview": (
        Path("spec/cmr-cli-readme.md"),
        Path("spec/qdm-time-policy.md"),
        Path("intents/financial-overview.md"),
        Path("routing/financial-overview.md"),
        Path("spec/financial-report.md"),
        Path("playbooks/financial-overview-analysis.md"),
    ),
}


def build_time_context(prompt: str, current_date: str) -> dict[str, object]:
    try:
        current = dt.date.fromisoformat(current_date)
    except ValueError:
        current = dt.date.today()
    return {
        "current_date": current.isoformat(),
        "timezone": os.environ.get("QDM_HARNESS_TIMEZONE") or os.environ.get("TZ") or "Asia/Shanghai",
        "time_policy": "Use spec/qdm-time-policy.md to infer --date, --week, or --month. Do not use date ranges.",
        "prompt": prompt,
    }


def append_file(parts: list[str], title: str, path: Path) -> None:
    if path.is_file():
        parts.append(f"\n\n## {title}\n\n")
        parts.append(path.read_text(encoding="utf-8"))


def context_file_diagnostics(harness_dir: Path, report_name: str) -> list[dict[str, object]]:
    diagnostics: list[dict[str, object]] = []
    for relative_path in CONTEXT_FILES.get(report_name, ()):
        path = harness_dir / relative_path
        stats = path_stats(path)
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
        diagnostics.append(
            {
                **stats,
                "relative_path": str(relative_path),
                "cross_report_keyword_hits": cross_report_keyword_hits(report_name, text),
            }
        )
    return diagnostics


def record_context_diagnostic(
    project_dir: Path,
    harness_dir: Path,
    session_id: str,
    report_name: str,
    prompt: str,
    context: str,
    time_context: dict[str, object],
) -> None:
    if not diagnostics_enabled():
        return
    write_diagnostic_event(
        project_dir,
        session_id,
        {
            "event": "user_prompt_context",
            "report_name": report_name,
            "prompt_bytes": len(prompt.encode("utf-8")),
            "context_bytes": len(context.encode("utf-8")),
            "context_lines": context.count("\n") + (1 if context and not context.endswith("\n") else 0),
            "time_context": time_context,
            "injected_files": context_file_diagnostics(harness_dir, report_name),
            "cross_report_keyword_hits": cross_report_keyword_hits(report_name, context),
        },
    )


def build_store_filter_context(time_context: dict[str, object]) -> dict[str, object]:
    return {
        **time_context,
        "default_area_filter": "--area-type 管理区域 --area CN00",
        "default_category_filter": "--category-type 大分类 --category 00",
        "area_label": "全国（不含港澳）",
        "area_defaulted": True,
        "category_label": "全品类",
        "category_fixed": True,
    }


def build_member_filter_context(time_context: dict[str, object]) -> dict[str, object]:
    return {
        **time_context,
        "default_area_filter": "--area-type 管理区域 --area CN00",
        "area_label": "全国（不含港澳）",
        "area_defaulted": True,
        "category_label": "用户报表默认全口径",
        "category_supported": False,
        "category_filter": "",
    }


def build_financial_filter_context(time_context: dict[str, object]) -> dict[str, object]:
    return {
        **time_context,
        "time_requirement": "company reports use --week or --month only; convert date questions to the containing ISO week.",
        "area_label": "未指定区域（公司报表区域维度可选；CLI 默认全国口径）",
        "area_optional": True,
        "area_filter": "",
        "category_label": "全品类",
        "category_supported": False,
        "category_filter": "",
    }


def append_common_context(parts: list[str], harness_dir: Path) -> None:
    append_file(parts, "CMR CLI Readme", harness_dir / "spec" / "cmr-cli-readme.md")
    append_file(parts, "QDM Time Policy", harness_dir / "spec" / "qdm-time-policy.md")


def build_context(prompt: str, project_dir: Path, harness_dir: Path, time_context: dict[str, object]) -> str:
    parts: list[str] = []
    parts.append("# QDM 经营分析深度报告上下文\n\n")
    parts.append("本轮用户 prompt 命中 `business_overview`。这不是普通摘要，而是固定结构的深度经营分析报告。\n\n")
    parts.append(f"时间上下文 JSON：`{json.dumps(time_context, ensure_ascii=False, separators=(',', ':'))}`\n\n")
    parts.append("必须根据 `spec/qdm-time-policy.md` 推理 CLI 时间参数；hook 不预设最终时间过滤条件。\n\n")
    parts.append("强制约束：\n\n")
    parts.append("- query_type=business_overview\n")
    parts.append("- report=business\n")
    parts.append("- needs_clarification=false\n")
    parts.append("- 必须走 qdm-cmr-cli，禁止把泛问经营概览路由到 qdm-indicators-cli。\n")
    parts.append("- 必须允许多次 CMR 查询，不能只做一句话摘要。\n")
    parts.append("- 必须完成 overview、indicators、tree --values、area、category、trend 六个模块的成功取数。\n")
    parts.append("- 取数前必须遵守 `spec/business-report.md` 的指标归属、口径、禁放规则，并在报告生成阶段继续遵守。\n")
    parts.append("- signal 前不注入 template，也不需要读取、打开、猜测或使用任何 template 文件。\n")
    parts.append("- 六个模块全部成功取数后，下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py business-overview`。\n")
    parts.append("- 六个模块成功后、signal 前，禁止总结、禁止整理报告素材、禁止生成中间分析、禁止向用户输出阶段性结论。\n")
    parts.append("- spec 已在取数前注入；在 signal 成功并收到 template 二阶段注入前，禁止输出最终报告正文。\n")
    parts.append("- 最终报告必须直接作为本轮助手回复正文输出，禁止创建、写入或保存任何报告文件。\n")
    parts.append("- 除非用户明确要求导出文件，否则不得使用 Write/Edit/重定向/tee/heredoc 等方式把报告写入 .md、output/ 或其他本地文件。\n")
    parts.append("- qdm-cmr-cli 的命令、参数、`--ai` 白名单和失败重试规则以 `spec/cmr-cli-readme.md` 为准。\n")
    parts.append("- signal 后收到 template 时，最终报告章节、指标组和表格结构以该 template 为准。\n")
    parts.append("- 诊断格式固定为“现象 -> 影响 -> 推断”。\n")
    parts.append("- 数值、同比、环比、排名、阈值必须来自 CLI 输出。\n")
    parts.append("- 推断只能基于已返回数据做有限判断。\n")
    parts.append("CLI 路径和参数规则以 `spec/cmr-cli-readme.md` 为准。\n\n")
    parts.append("建议命令骨架：\n\n")
    parts.append("```bash\n")
    parts.append("source config/qdm-cli-paths.env\n")
    parts.append('"$QDM_CMR_CLI" report business overview <time_filter> --ai\n')
    parts.append('"$QDM_CMR_CLI" report business indicators <time_filter> --ai\n')
    parts.append('"$QDM_CMR_CLI" report business tree --values <time_filter>\n')
    parts.append('"$QDM_CMR_CLI" report business area <time_filter> --ai\n')
    parts.append('"$QDM_CMR_CLI" report business category <time_filter> --ai\n')
    parts.append('"$QDM_CMR_CLI" report business trend <time_filter> --ai\n')
    parts.append("python3 .claude/hooks/before-report-signal.py business-overview\n")
    parts.append("```\n")
    parts.append("其中 `<time_filter>` 按 `spec/qdm-time-policy.md` 推理，只能是 `--date`、`--week` 或 `--month` 之一。\n")

    append_common_context(parts, harness_dir)
    append_file(parts, "Intent Spec", harness_dir / "intents" / "business-overview.md")
    append_file(parts, "Routing Rules", harness_dir / "routing" / "business-overview.md")
    append_file(parts, "Report Spec", harness_dir / "spec" / "business-report.md")
    append_file(parts, "Analysis Playbook", harness_dir / "playbooks" / "business-overview-analysis.md")

    return "".join(parts)


def build_store_context(prompt: str, project_dir: Path, harness_dir: Path, time_context: dict[str, object]) -> str:
    store_filter = build_store_filter_context(time_context)
    parts: list[str] = []
    parts.append("# QDM 门店管理深度报告上下文\n\n")
    parts.append("本轮用户 prompt 命中 `store_overview`。这不是普通摘要，而是固定结构的门店管理深度报告。\n\n")
    parts.append(f"时间与默认过滤上下文 JSON：`{json.dumps(store_filter, ensure_ascii=False, separators=(',', ':'))}`\n\n")
    parts.append("必须根据 `spec/qdm-time-policy.md` 推理 CLI 时间参数；若用户未给区域，默认全国（不含港澳）；品类固定为全品类。\n\n")
    parts.append("强制约束：\n\n")
    parts.append("- query_type=store_overview\n")
    parts.append("- report=store\n")
    parts.append("- needs_clarification=false\n")
    parts.append("- 必须走 qdm-cmr-cli，禁止把门店管理报告路由到 qdm-indicators-cli。\n")
    parts.append("- 必须使用 `qdm-cmr-cli report store overview --ai` 作为主取数入口。\n")
    parts.append("- 默认全国全品类场景只要求完成 `overview` 必需模块；不要主动拆开调用 `indicators`、`area`、`category`、`trend`。\n")
    parts.append("- 只有在用户指定非全国区域、overview 口径异常、区域子指标明细不足或需要校验图谱时，才允许补充 `inspect`、`tree --values` 或 `table`。\n")
    parts.append("- 取数前必须遵守 `spec/store-report.md` 的指标归属、口径、禁放规则，并在报告生成阶段继续遵守。\n")
    parts.append("- signal 前不注入 template，也不需要读取、打开、猜测或使用任何 template 文件。\n")
    parts.append("- `overview` 成功取数后，下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py store-overview`。\n")
    parts.append("- `overview` 成功后、signal 前，禁止总结、禁止整理报告素材、禁止生成中间分析、禁止向用户输出阶段性结论。\n")
    parts.append("- spec 已在取数前注入；在 signal 成功并收到 template 二阶段注入前，禁止输出最终报告正文。\n")
    parts.append("- 最终报告必须直接作为本轮助手回复正文输出，禁止创建、写入或保存任何报告文件。\n")
    parts.append("- 除非用户明确要求导出文件，否则不得使用 Write/Edit/重定向/tee/heredoc 等方式把报告写入 .md、output/ 或其他本地文件。\n")
    parts.append("- 品类口径固定为全品类，不得生成品类下钻分析。\n")
    parts.append("- 区域口径默认全国（不含港澳），区域支持下钻但必须以 CLI 返回为准。\n")
    parts.append("- signal 后收到 template 时，最终报告章节、指标组和表格结构以该 template 为准。\n")
    parts.append("- 诊断格式固定为“现象 -> 影响 -> 推断”。\n")
    parts.append("- 数值、同比、环比、排名、阈值必须来自 CLI 输出。\n")
    parts.append("- 推断只能基于已返回数据做有限判断。\n")
    parts.append("- qdm-cmr-cli 的命令、参数、`--ai` 白名单和失败重试规则以 `spec/cmr-cli-readme.md` 为准。\n")
    parts.append("CLI 路径和参数规则以 `spec/cmr-cli-readme.md` 为准。\n\n")
    parts.append("建议命令骨架：\n\n")
    parts.append("```bash\n")
    parts.append("source config/qdm-cli-paths.env\n")
    parts.append('"$QDM_CMR_CLI" report store overview <time_filter> --area-type 管理区域 --area CN00 --category-type 大分类 --category 00 --ai\n')
    parts.append("python3 .claude/hooks/before-report-signal.py store-overview\n")
    parts.append("```\n")
    parts.append("其中 `<time_filter>` 按 `spec/qdm-time-policy.md` 推理，只能是 `--date`、`--week` 或 `--month` 之一。\n")

    append_common_context(parts, harness_dir)
    append_file(parts, "Intent Spec", harness_dir / "intents" / "store-overview.md")
    append_file(parts, "Routing Rules", harness_dir / "routing" / "store-overview.md")
    append_file(parts, "Report Spec", harness_dir / "spec" / "store-report.md")
    append_file(parts, "Analysis Playbook", harness_dir / "playbooks" / "store-overview-analysis.md")

    return "".join(parts)


def build_member_context(prompt: str, project_dir: Path, harness_dir: Path, time_context: dict[str, object]) -> str:
    member_filter = build_member_filter_context(time_context)
    parts: list[str] = []
    parts.append("# QDM 用户运营深度报告上下文\n\n")
    parts.append("本轮用户 prompt 命中 `member_overview`。这不是普通摘要，而是固定结构的用户运营深度报告。\n\n")
    parts.append(f"时间与默认过滤上下文 JSON：`{json.dumps(member_filter, ensure_ascii=False, separators=(',', ':'))}`\n\n")
    parts.append("必须根据 `spec/qdm-time-policy.md` 推理 CLI 时间参数；若用户未给区域，默认全国（不含港澳）。用户报表不支持品类过滤，不能传入品类参数。\n\n")
    parts.append("强制约束：\n\n")
    parts.append("- query_type=member_overview\n")
    parts.append("- report=user\n")
    parts.append("- needs_clarification=false\n")
    parts.append("- 必须走 qdm-cmr-cli，禁止把用户运营报告路由到 qdm-indicators-cli。\n")
    parts.append("- 必须使用 `qdm-cmr-cli report user overview --ai` 作为主取数入口。\n")
    parts.append("- 默认全国场景只要求完成 `overview` 必需模块；不要主动拆开调用 `indicators`、`area`、`category`、`trend`。\n")
    parts.append("- 用户报表不支持 `--category-type` 和 `--category`，即使用户表达全品类也不得传入品类过滤。\n")
    parts.append("- 只有在用户指定非全国区域、overview 口径异常、区域子指标明细不足或需要校验图谱时，才允许补充 `inspect`、`tree --values` 或 `table`。\n")
    parts.append("- 取数前必须遵守 `spec/member-report.md` 的指标归属、口径、禁放规则，并在报告生成阶段继续遵守。\n")
    parts.append("- signal 前不注入 template，也不需要读取、打开、猜测或使用任何 template 文件。\n")
    parts.append("- `overview` 成功取数后，下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py member-overview`。\n")
    parts.append("- `overview` 成功后、signal 前，禁止总结、禁止整理报告素材、禁止生成中间分析、禁止向用户输出阶段性结论。\n")
    parts.append("- spec 已在取数前注入；在 signal 成功并收到 template 二阶段注入前，禁止输出最终报告正文。\n")
    parts.append("- 最终报告必须直接作为本轮助手回复正文输出，禁止创建、写入或保存任何报告文件。\n")
    parts.append("- 除非用户明确要求导出文件，否则不得使用 Write/Edit/重定向/tee/heredoc 等方式把报告写入 .md、output/ 或其他本地文件。\n")
    parts.append("- 品类口径写为用户报表默认全口径，不得生成品类下钻分析。\n")
    parts.append("- 区域口径默认全国（不含港澳），区域支持下钻但必须以 CLI 返回为准。\n")
    parts.append("- signal 后收到 template 时，最终报告章节、指标组和表格结构以该 template 为准。\n")
    parts.append("- 诊断格式固定为“现象 -> 影响 -> 推断”。\n")
    parts.append("- 数值、同比、环比、排名、阈值必须来自 CLI 输出。\n")
    parts.append("- 推断只能基于已返回数据做有限判断。\n")
    parts.append("- qdm-cmr-cli 的命令、参数、`--ai` 白名单和失败重试规则以 `spec/cmr-cli-readme.md` 为准。\n")
    parts.append("CLI 路径和参数规则以 `spec/cmr-cli-readme.md` 为准。\n\n")
    parts.append("建议命令骨架：\n\n")
    parts.append("```bash\n")
    parts.append("source config/qdm-cli-paths.env\n")
    parts.append('"$QDM_CMR_CLI" report user overview <time_filter> --area-type 管理区域 --area CN00 --ai\n')
    parts.append("python3 .claude/hooks/before-report-signal.py member-overview\n")
    parts.append("```\n")
    parts.append("其中 `<time_filter>` 按 `spec/qdm-time-policy.md` 推理，只能是 `--date`、`--week` 或 `--month` 之一，且不得追加品类过滤。\n")

    append_common_context(parts, harness_dir)
    append_file(parts, "Intent Spec", harness_dir / "intents" / "member-overview.md")
    append_file(parts, "Routing Rules", harness_dir / "routing" / "member-overview.md")
    append_file(parts, "Report Spec", harness_dir / "spec" / "member-report.md")
    append_file(parts, "Analysis Playbook", harness_dir / "playbooks" / "member-overview-analysis.md")

    return "".join(parts)


def build_financial_context(prompt: str, project_dir: Path, harness_dir: Path, time_context: dict[str, object]) -> str:
    financial_filter = build_financial_filter_context(time_context)
    parts: list[str] = []
    parts.append("# QDM 财务核心指标深度报告上下文\n\n")
    parts.append("本轮用户 prompt 命中 `financial_overview`。这不是普通摘要，而是固定结构的财务核心指标深度报告。\n\n")
    parts.append(f"时间与默认过滤上下文 JSON：`{json.dumps(financial_filter, ensure_ascii=False, separators=(',', ':'))}`\n\n")
    parts.append("必须根据 `spec/qdm-time-policy.md` 推理 CLI 时间参数。公司/财务报表不支持日维度，用户问昨天、今天或具体日期时，必须转换为该日期所在周；若用户未给时间，默认昨天所在周。区域维度可选，默认不强制追加区域过滤；品类维度不可选，默认全品类且不得传入品类参数。\n\n")
    parts.append("强制约束：\n\n")
    parts.append("- query_type=financial_overview\n")
    parts.append("- report=company\n")
    parts.append("- needs_clarification=false\n")
    parts.append("- 必须走 qdm-cmr-cli，禁止把财务报告路由到 qdm-indicators-cli。\n")
    parts.append("- 公司/财务报表只支持周、月时间粒度；不得对 company 报表使用 `--date`。\n")
    parts.append("- 若用户询问昨天、今天或具体日期，必须改用该日期所在 ISO 周的 `--week YYYY-Www`，并在最终报告概述中说明“不支持日维度，已按所在周统计”。\n")
    parts.append("- 品类维度不可选，不得传入 `--category-type` 或 `--category`；报告品类口径固定写为全品类。\n")
    parts.append("- 区域维度可选；用户未指定区域时不强制追加区域过滤，按 CLI 默认全国口径执行。\n")
    parts.append("- 必须完成 `report company indicators --ai`、`report company tree --values`、`table --report company --indicator EBITDA --dim-type 管理区域 --ai` 三个必需取数动作。\n")
    parts.append("- `indicators --ai` 提供当前值、同比、环比；`tree --values` 提供财务指标树和部分节点值；`table EBITDA 管理区域 --ai` 提供 EBITDA 树下收入、毛利、费用结构当前值。\n")
    parts.append("- `overview --ai`、`area --ai`、`category --ai`、`trend --ai` 已实测无法稳定补齐财务模板指标，不作为默认必需模块。\n")
    parts.append("- 只有在用户指定区域、口径异常或需要额外下钻时，才允许补充 `inspect`、`overview --ai`、`area --ai`、`category --ai`、`trend --ai` 或额外 `table`；用户提出品类筛选时必须说明 company 报表不支持品类维度。\n")
    parts.append("- 取数前必须遵守 `spec/financial-report.md` 的指标归属、口径、禁放规则，并在报告生成阶段继续遵守。\n")
    parts.append("- signal 前不注入 template，也不需要读取、打开、猜测或使用任何 template 文件。\n")
    parts.append("- 三个必需取数动作全部成功后，下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py financial-overview`。\n")
    parts.append("- 必需取数动作成功后、signal 前，禁止总结、禁止整理报告素材、禁止生成中间分析、禁止向用户输出阶段性结论。\n")
    parts.append("- spec 已在取数前注入；在 signal 成功并收到 template 二阶段注入前，禁止输出最终报告正文。\n")
    parts.append("- 最终报告必须直接作为本轮助手回复正文输出，禁止创建、写入或保存任何报告文件。\n")
    parts.append("- 除非用户明确要求导出文件，否则不得使用 Write/Edit/重定向/tee/heredoc 等方式把报告写入 .md、output/ 或其他本地文件。\n")
    parts.append("- signal 后收到 template 时，最终报告章节、指标组和表格结构以该 template 为准。\n")
    parts.append("- 诊断格式固定为“现象 -> 影响 -> 推断”。\n")
    parts.append("- 数值、同比、环比、排名、阈值必须来自 CLI 输出。\n")
    parts.append("- 推断只能基于已返回数据做有限判断。\n")
    parts.append("- 不得使用 `templates/financial-demo.md` 中的示例数值替代 CLI 返回值。\n")
    parts.append("- qdm-cmr-cli 的命令、参数、`--ai` 白名单和失败重试规则以 `spec/cmr-cli-readme.md` 为准。\n")
    parts.append("CLI 路径和参数规则以 `spec/cmr-cli-readme.md` 为准。\n\n")
    parts.append("建议命令骨架：\n\n")
    parts.append("```bash\n")
    parts.append("source config/qdm-cli-paths.env\n")
    parts.append('"$QDM_CMR_CLI" report company indicators <time_filter> --ai\n')
    parts.append('"$QDM_CMR_CLI" report company tree --values <time_filter>\n')
    parts.append('"$QDM_CMR_CLI" table --report company <time_filter> --indicator EBITDA --dim-type 管理区域 --ai\n')
    parts.append("python3 .claude/hooks/before-report-signal.py financial-overview\n")
    parts.append("```\n")
    parts.append("其中 `<time_filter>` 按 `spec/qdm-time-policy.md` 推理；company 报表只能使用 `--week` 或 `--month`。\n")

    append_common_context(parts, harness_dir)
    append_file(parts, "Intent Spec", harness_dir / "intents" / "financial-overview.md")
    append_file(parts, "Routing Rules", harness_dir / "routing" / "financial-overview.md")
    append_file(parts, "Report Spec", harness_dir / "spec" / "financial-report.md")
    append_file(parts, "Analysis Playbook", harness_dir / "playbooks" / "financial-overview-analysis.md")

    return "".join(parts)


def main() -> int:
    raw = sys.stdin.read()
    prompt = parse_prompt(raw)
    if not prompt:
        return 0
    project_dir = resolve_project_dir()
    harness_dir = resolve_harness_dir(project_dir)
    session_id = str(os.environ.get("CLAUDE_SESSION_ID") or "unknown")
    current_date = os.environ.get("QDM_HARNESS_CURRENT_DATE") or dt.date.today().isoformat()
    time_context = build_time_context(prompt, current_date)
    if STORE_OVERVIEW_RE.search(prompt):
        report_name = "store-overview"
        context = build_store_context(prompt, project_dir, harness_dir, time_context)
    elif MEMBER_OVERVIEW_RE.search(prompt):
        report_name = "member-overview"
        context = build_member_context(prompt, project_dir, harness_dir, time_context)
    elif FINANCIAL_OVERVIEW_RE.search(prompt):
        report_name = "financial-overview"
        context = build_financial_context(prompt, project_dir, harness_dir, time_context)
    elif BUSINESS_OVERVIEW_RE.search(prompt):
        report_name = "business-overview"
        context = build_context(prompt, project_dir, harness_dir, time_context)
    else:
        return 0
    record_context_diagnostic(project_dir, harness_dir, session_id, report_name, prompt, context, time_context)
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
