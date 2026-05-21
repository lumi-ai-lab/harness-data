#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import tempfile
from pathlib import Path


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
    parts.append("- 推荐至少查询 overview、indicators、tree --values，并补充 area、category、trend。\n")
    parts.append("- 对支持 `--ai` 的 qdm-cmr-cli 查询默认追加 `--ai`；`tree --values` 当前不追加。\n")
    parts.append("- 章节顺序固定，按模板输出 1 到 9。\n")
    parts.append("- 模板显式规定的章节、指标归属、指标组和表格结构优先级高于模型自由组织。\n")
    parts.append("- 如果模板有固定指标清单，报告必须优先遵循该清单，不得随意移动指标到其他章节。\n")
    parts.append("- 模板未覆盖的 CLI 返回指标，才允许按语义补充到最匹配章节。\n")
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
    parts.append("```\n")
    parts.append("其中 `<cli_filter>` 使用时间解析 JSON 中的 `cli_filter`。\n")

    append_file(parts, "Intent Spec", harness_dir / "intents" / "business-overview.md")
    append_file(parts, "Routing Rules", harness_dir / "routing" / "qdm-cli-routing.md")
    append_file(parts, "Analysis Playbook", harness_dir / "playbooks" / "business-overview-analysis.md")
    append_file(parts, "Report Template", harness_dir / "templates" / "business-overview-report.md")

    return "".join(parts)


def main() -> int:
    raw = sys.stdin.read()
    prompt = parse_prompt(raw)
    if not prompt:
        return 0
    if not BUSINESS_OVERVIEW_RE.search(prompt):
        return 0

    project_dir = resolve_project_dir()
    harness_dir = resolve_harness_dir(project_dir)
    current_date = os.environ.get("QDM_HARNESS_CURRENT_DATE") or dt.date.today().isoformat()
    date_info = build_date_info(prompt, current_date)
    context = build_context(prompt, project_dir, harness_dir, date_info)
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
