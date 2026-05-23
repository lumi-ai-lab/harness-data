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
CONTEXT_FILES = {
    "business-overview": (
        Path("intents/business-overview.md"),
        Path("routing/business-overview.md"),
        Path("spec/business-report.md"),
        Path("playbooks/business-overview-analysis.md"),
    ),
    "store-overview": (
        Path("intents/store-overview.md"),
        Path("routing/store-overview.md"),
        Path("spec/store-report.md"),
        Path("playbooks/store-overview-analysis.md"),
    ),
    "member-overview": (
        Path("intents/member-overview.md"),
        Path("routing/member-overview.md"),
        Path("spec/member-report.md"),
        Path("playbooks/member-overview-analysis.md"),
    ),
}


def month_delta(date_str: str, delta: int) -> str | None:
    try:
        parsed = dt.date.fromisoformat(date_str)
    except ValueError:
        return None
    year = parsed.year
    month = parsed.month + delta
    while month < 1:
        month += 12
        year -= 1
    while month > 12:
        month -= 12
        year += 1
    return f"{year:04d}-{month:02d}"


def iso_week_label(day: dt.date) -> str:
    iso_year, iso_week, _ = day.isocalendar()
    return f"{iso_year:04d}-W{iso_week:02d}"


def build_date_info(prompt: str, current_date: str) -> dict[str, object]:
    try:
        current = dt.date.fromisoformat(current_date)
    except ValueError:
        current = dt.date.today()

    yesterday = current - dt.timedelta(days=1)
    out: dict[str, object] = {
        "current_date": current.isoformat(),
        "defaulted": False,
        "cli_filter": f"--date {yesterday.isoformat()}",
        "time_label": yesterday.isoformat(),
        "time_grain": "date",
    }

    match = re.search(r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?", prompt)
    if match:
        date_str = f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
        out.update(cli_filter=f"--date {date_str}", time_label=date_str, time_grain="date", defaulted=False)
        return out

    if re.search(r"今天|今日", prompt):
        out.update(cli_filter=f"--date {current.isoformat()}", time_label=current.isoformat(), time_grain="date", defaulted=False)
        return out

    if re.search(r"昨天|昨日", prompt):
        out.update(cli_filter=f"--date {yesterday.isoformat()}", time_label=yesterday.isoformat(), time_grain="date", defaulted=False)
        return out

    if re.search(r"上周", prompt):
        week_day = current - dt.timedelta(days=7)
        out.update(cli_filter=f"--week {iso_week_label(week_day)}", time_label=iso_week_label(week_day), time_grain="week", defaulted=False)
        return out

    if re.search(r"本周|这周", prompt):
        out.update(cli_filter=f"--week {iso_week_label(current)}", time_label=iso_week_label(current), time_grain="week", defaulted=False)
        return out

    if re.search(r"上月", prompt):
        month = month_delta(current.isoformat(), -1)
        if month:
          out.update(cli_filter=f"--month {month}", time_label=month, time_grain="month", defaulted=False)
        return out

    if re.search(r"本月|这个月", prompt):
        month = current.isoformat()[:7]
        out.update(cli_filter=f"--month {month}", time_label=month, time_grain="month", defaulted=False)
        return out

    out["defaulted"] = True
    return out


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
    date_info: dict[str, object],
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
            "date_info": date_info,
            "injected_files": context_file_diagnostics(harness_dir, report_name),
            "cross_report_keyword_hits": cross_report_keyword_hits(report_name, context),
        },
    )


def build_store_filter(date_info: dict[str, object]) -> dict[str, object]:
    cli_filter = str(date_info.get("cli_filter") or "")
    store_filter = {
        **date_info,
        "cli_filter": f"{cli_filter} --area-type 管理区域 --area CN00 --category-type 大分类 --category 00",
        "area_label": "全国（不含港澳）",
        "area_defaulted": True,
        "category_label": "全品类",
        "category_fixed": True,
    }
    return store_filter


def build_member_filter(date_info: dict[str, object]) -> dict[str, object]:
    cli_filter = str(date_info.get("cli_filter") or "")
    member_filter = {
        **date_info,
        "cli_filter": f"{cli_filter} --area-type 管理区域 --area CN00",
        "area_label": "全国（不含港澳）",
        "area_defaulted": True,
        "category_label": "用户报表默认全口径",
        "category_supported": False,
        "category_filter": "",
    }
    return member_filter


def build_context(prompt: str, project_dir: Path, harness_dir: Path, date_info: dict[str, object]) -> str:
    parts: list[str] = []
    parts.append("# QDM 经营分析深度报告上下文\n\n")
    parts.append("本轮用户 prompt 命中 `business_overview`。这不是普通摘要，而是固定结构的深度经营分析报告。\n\n")
    parts.append(f"时间解析 JSON：`{json.dumps(date_info, ensure_ascii=False, separators=(',', ':'))}`\n\n")
    parts.append("必须使用解析出的 CLI 时间过滤条件执行 CMR 查询。若用户未给时间，默认昨天。\n\n")
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
    parts.append("- 对支持 `--ai` 的 qdm-cmr-cli 查询默认追加 `--ai`；`tree --values` 当前不追加。\n")
    parts.append("- signal 后收到 template 时，最终报告章节、指标组和表格结构以该 template 为准。\n")
    parts.append("- 诊断格式固定为“现象 -> 影响 -> 推断”。\n")
    parts.append("- 数值、同比、环比、排名、阈值必须来自 CLI 输出。\n")
    parts.append("- 推断只能基于已返回数据做有限判断。\n")
    parts.append("CLI 路径配置：先读取当前项目的 `config/qdm-cli-paths.env`，使用其中的 `$QDM_CMR_CLI`。\n\n")
    parts.append("建议命令骨架：\n\n")
    parts.append("```bash\n")
    parts.append("source config/qdm-cli-paths.env\n")
    parts.append('"$QDM_CMR_CLI" report business overview <cli_filter> --ai\n')
    parts.append('"$QDM_CMR_CLI" report business indicators <cli_filter> --ai\n')
    parts.append('"$QDM_CMR_CLI" report business tree --values <cli_filter>\n')
    parts.append('"$QDM_CMR_CLI" report business area <cli_filter> --ai\n')
    parts.append('"$QDM_CMR_CLI" report business category <cli_filter> --ai\n')
    parts.append('"$QDM_CMR_CLI" report business trend <cli_filter> --ai\n')
    parts.append("python3 .claude/hooks/before-report-signal.py business-overview\n")
    parts.append("```\n")
    parts.append("其中 `<cli_filter>` 使用时间解析 JSON 中的 `cli_filter`。\n")

    append_file(parts, "Intent Spec", harness_dir / "intents" / "business-overview.md")
    append_file(parts, "Routing Rules", harness_dir / "routing" / "business-overview.md")
    append_file(parts, "Report Spec", harness_dir / "spec" / "business-report.md")
    append_file(parts, "Analysis Playbook", harness_dir / "playbooks" / "business-overview-analysis.md")

    return "".join(parts)


def build_store_context(prompt: str, project_dir: Path, harness_dir: Path, date_info: dict[str, object]) -> str:
    store_filter = build_store_filter(date_info)
    parts: list[str] = []
    parts.append("# QDM 门店管理深度报告上下文\n\n")
    parts.append("本轮用户 prompt 命中 `store_overview`。这不是普通摘要，而是固定结构的门店管理深度报告。\n\n")
    parts.append(f"时间与过滤条件解析 JSON：`{json.dumps(store_filter, ensure_ascii=False, separators=(',', ':'))}`\n\n")
    parts.append("必须使用解析出的 CLI 过滤条件执行 CMR 查询。若用户未给时间，默认昨天；若用户未给区域，默认全国（不含港澳）；品类固定为全品类。\n\n")
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
    parts.append("CLI 路径配置：先读取当前项目的 `config/qdm-cli-paths.env`，使用其中的 `$QDM_CMR_CLI`。\n\n")
    parts.append("建议命令骨架：\n\n")
    parts.append("```bash\n")
    parts.append("source config/qdm-cli-paths.env\n")
    parts.append('"$QDM_CMR_CLI" report store overview <cli_filter> --ai\n')
    parts.append("python3 .claude/hooks/before-report-signal.py store-overview\n")
    parts.append("```\n")
    parts.append("其中 `<cli_filter>` 使用时间与过滤条件解析 JSON 中的 `cli_filter`。\n")

    append_file(parts, "Intent Spec", harness_dir / "intents" / "store-overview.md")
    append_file(parts, "Routing Rules", harness_dir / "routing" / "store-overview.md")
    append_file(parts, "Report Spec", harness_dir / "spec" / "store-report.md")
    append_file(parts, "Analysis Playbook", harness_dir / "playbooks" / "store-overview-analysis.md")

    return "".join(parts)


def build_member_context(prompt: str, project_dir: Path, harness_dir: Path, date_info: dict[str, object]) -> str:
    member_filter = build_member_filter(date_info)
    parts: list[str] = []
    parts.append("# QDM 用户运营深度报告上下文\n\n")
    parts.append("本轮用户 prompt 命中 `member_overview`。这不是普通摘要，而是固定结构的用户运营深度报告。\n\n")
    parts.append(f"时间与过滤条件解析 JSON：`{json.dumps(member_filter, ensure_ascii=False, separators=(',', ':'))}`\n\n")
    parts.append("必须使用解析出的 CLI 过滤条件执行 CMR 查询。若用户未给时间，默认昨天；若用户未给区域，默认全国（不含港澳）。用户报表不支持品类过滤，不能传入品类参数。\n\n")
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
    parts.append("CLI 路径配置：先读取当前项目的 `config/qdm-cli-paths.env`，使用其中的 `$QDM_CMR_CLI`。\n\n")
    parts.append("建议命令骨架：\n\n")
    parts.append("```bash\n")
    parts.append("source config/qdm-cli-paths.env\n")
    parts.append('"$QDM_CMR_CLI" report user overview <cli_filter> --ai\n')
    parts.append("python3 .claude/hooks/before-report-signal.py member-overview\n")
    parts.append("```\n")
    parts.append("其中 `<cli_filter>` 使用时间与过滤条件解析 JSON 中的 `cli_filter`，且不得追加品类过滤。\n")

    append_file(parts, "Intent Spec", harness_dir / "intents" / "member-overview.md")
    append_file(parts, "Routing Rules", harness_dir / "routing" / "member-overview.md")
    append_file(parts, "Report Spec", harness_dir / "spec" / "member-report.md")
    append_file(parts, "Analysis Playbook", harness_dir / "playbooks" / "member-overview-analysis.md")

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
    date_info = build_date_info(prompt, current_date)
    if STORE_OVERVIEW_RE.search(prompt):
        report_name = "store-overview"
        context = build_store_context(prompt, project_dir, harness_dir, date_info)
    elif MEMBER_OVERVIEW_RE.search(prompt):
        report_name = "member-overview"
        context = build_member_context(prompt, project_dir, harness_dir, date_info)
    elif BUSINESS_OVERVIEW_RE.search(prompt):
        report_name = "business-overview"
        context = build_context(prompt, project_dir, harness_dir, date_info)
    else:
        return 0
    record_context_diagnostic(project_dir, harness_dir, session_id, report_name, prompt, context, date_info)
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
