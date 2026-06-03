#!/usr/bin/env python3
"""Generate CMR financial single-metric playbooks from a JSON manifest."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "scripts" / "cmr_financial_playbook_metrics.json"
DEFAULT_TEMPLATE = ROOT / "scripts" / "templates" / "cmr_financial_single_playbook.md.j2"
SPEC_DIR = ROOT / "wikis" / "spec" / "cmr" / "financial"
PLAYBOOK_DIR = ROOT / "wikis" / "playbooks" / "cmr" / "financial"


@dataclass(frozen=True)
class Metric:
    label: str
    code: str
    aliases: tuple[str, ...]
    query_strategy: str
    cli_indicator_name: str
    response_indicator_name: str


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE)
    parser.add_argument("--output-dir", type=Path, default=PLAYBOOK_DIR)
    parser.add_argument("--spec-dir", type=Path, default=SPEC_DIR)
    parser.add_argument("--force", action="store_true", help="overwrite existing playbooks")
    parser.add_argument("--check", action="store_true", help="validate and render without writing files")
    args = parser.parse_args()

    try:
        metrics = load_manifest(args.manifest)
        template = args.template.read_text(encoding="utf-8")
        rendered = [
            (metric, output_path(args.output_dir, metric.code), render_playbook(template, metric))
            for metric in metrics
        ]
        validate(metrics, args.spec_dir)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    created = []
    updated = []
    skipped = []
    unchanged = []
    for metric, out_path, content in rendered:
        if out_path.exists():
            if out_path.read_text(encoding="utf-8") == content:
                unchanged.append(out_path)
                continue
            if not args.force:
                skipped.append(out_path)
                continue
            updated.append(out_path)
            if not args.check:
                out_path.write_text(content, encoding="utf-8")
            continue
        created.append(out_path)
        if not args.check:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(content, encoding="utf-8")

    action = "check" if args.check else "generate"
    print(
        f"{action} ok: manifest={len(metrics)} "
        f"created={len(created)} updated={len(updated)} "
        f"skipped={len(skipped)} unchanged={len(unchanged)}"
    )
    print_paths("created", created)
    print_paths("updated", updated)
    print_paths("skipped_existing", skipped)
    return 0


def load_manifest(path: Path) -> list[Metric]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"manifest not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid manifest JSON: {exc}") from exc
    if not isinstance(raw, list):
        raise ValueError("manifest must be a JSON array")

    metrics = []
    seen_codes = set()
    for index, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise ValueError(f"manifest item #{index} must be an object")
        label = required_str(item, "label", index)
        code = required_str(item, "code", index)
        if code in seen_codes:
            raise ValueError(f"duplicate code in manifest: {code}")
        seen_codes.add(code)
        aliases = item.get("aliases", [])
        if aliases is None:
            aliases = []
        if not isinstance(aliases, list) or not all(isinstance(value, str) and value.strip() for value in aliases):
            raise ValueError(f"aliases for {code} must be a list of non-empty strings")
        query_strategy = optional_str(item, "query_strategy") or "direct_indicator_name"
        if query_strategy not in {"direct_indicator_name", "report_all_filter_code"}:
            raise ValueError(f"unsupported query_strategy for {code}: {query_strategy}")
        cli_indicator_name = optional_str(item, "cli_indicator_name") or label
        response_indicator_name = optional_str(item, "response_indicator_name") or cli_indicator_name
        if query_strategy == "report_all_filter_code" and "cli_indicator_name" in item:
            raise ValueError(f"{code}: report_all_filter_code must not set cli_indicator_name")
        metrics.append(
            Metric(
                label=label,
                code=code,
                aliases=tuple(value.strip() for value in aliases),
                query_strategy=query_strategy,
                cli_indicator_name=cli_indicator_name,
                response_indicator_name=response_indicator_name,
            )
        )
    return metrics


def required_str(item: dict[str, Any], key: str, index: int) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"manifest item #{index} requires non-empty string field {key!r}")
    return value.strip()


def optional_str(item: dict[str, Any], key: str) -> str:
    value = item.get(key)
    if value is None:
        return ""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"optional field {key!r} must be a non-empty string when present")
    return value.strip()


def validate(metrics: list[Metric], spec_dir: Path) -> None:
    missing_specs = []
    for metric in metrics:
        spec_path = spec_dir / filename(metric.code)
        if not spec_path.exists():
            missing_specs.append(f"{metric.code} -> {spec_path.relative_to(ROOT)}")
    if missing_specs:
        joined = "\n  ".join(missing_specs)
        raise ValueError(f"missing spec file(s):\n  {joined}")


def render_playbook(template: str, metric: Metric) -> str:
    aliases = "、".join(metric.aliases)
    snippets = render_query_snippets(metric)
    values = {
        "frontmatter_name": f"playbook_cmr_financial_s_{slug_snake(metric.code)}",
        "label": metric.label,
        "code": metric.code,
        "alias_phrase": f"、{aliases}" if aliases else "",
        "cli_indicator_name": metric.cli_indicator_name,
        "response_indicator_name": metric.response_indicator_name,
        "query_strategy": metric.query_strategy,
        **snippets,
    }
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{ " + key + " }}", value)
    if "{{" in rendered or "}}" in rendered:
        raise ValueError("template contains unresolved placeholder(s)")
    return rendered if rendered.endswith("\n") else rendered + "\n"


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def render_query_snippets(metric: Metric) -> dict[str, str]:
    if metric.query_strategy == "report_all_filter_code":
        return render_code_filter_snippets(metric)
    return render_direct_snippets(metric)


def render_direct_snippets(metric: Metric) -> dict[str, str]:
    arg = f"--indicator-name {shell_quote(metric.cli_indicator_name)}"
    identity = f"""- 用户展示名：{metric.label}
- 稳定指标 code：`{metric.code}`
- CLI 查询名：`{metric.cli_indicator_name}`；取数命令使用这个名称，不要改用用户展示名以外的近似名称
- 最终回答仍使用用户展示名“{metric.label}”；CLI 返回 `indicatorName` 与展示名不一致时，同时保留 `indicatorCode` 作为证据"""
    return {
        "metric_identity_notes": identity,
        "current_query_description": f"查询满足过滤条件后的{metric.label}值，按 CLI 查询名 `{metric.cli_indicator_name}` 直查",
        "trend_query_description": f"查询{metric.label}按时间展开的趋势点",
        "area_query_description": f"查询{metric.label}按区域展开的表现",
        "current_value_method": f"当前值查询使用 `dupont --report company {arg} --week <YYYY-NN>`。如果用户问具体日期，先转成所在业务周，再执行该命令。当前值只查询用户显式给出的口径；未明确要求同比、环比、趋势、排名或额外对比时，不查询历史同期/上期，也不查询未提到的区域。",
        "current_value_default_command": f'"$QDM_CMR_CLI" dupont --report company {arg} --week <YYYY-NN>',
        "current_value_week_example": f'"$QDM_CMR_CLI" dupont --report company {arg} --week 2026-21',
        "current_value_month_example": f'"$QDM_CMR_CLI" dupont --report company {arg} --month 2026-05',
        "current_value_region_example": f'"$QDM_CMR_CLI" dupont --report company {arg} --week 2026-21 --area-type 管理区域 --area 粤西区',
        "current_value_area_region_example": f'"$QDM_CMR_CLI" dupont --report company {arg} --week 2026-21 --area-type 大区 --area 粤东一区',
        "trend_query_block": f"""用户询问“{metric.label}趋势”“{metric.label}走势”“最近{metric.label}变化”时，使用 `trend`。趋势命令固定查询 `grouping=ctime`，仍然只围绕{metric.label}这一个指标取数。

查询全国、全品类{metric.label}趋势：

```bash
source config/qdm-cli-paths.env
"$QDM_CMR_CLI" trend --report company {arg} --week 2026-21
```

趋势输出中只使用 CLI 返回的时间点和值。不要自行补齐缺失日期，也不要根据相邻点推算数值。""",
        "area_query_block": f"""用户询问“各区域{metric.label}”“哪个区域{metric.label}高”“哪个区域{metric.label}低”“区域排名”时，使用 `area`。区域表现命令固定查询 `grouping=storeId`，可以继续叠加时间过滤。

如果用户只是要求某一个或多个明确区域的当前值，即使表达中包含“全国和某区域”，也不是区域表现查询；应使用 `dupont` 分别查询这些明确口径。只有用户要求区域展开、排名、最高/最低、各区域对比时才使用 `area`。

区域层级必须按 CLI 实际返回判断，不要只按用户原词或命令参数猜测：

- 不传 `--area-type/--area` 时，默认范围是 `管理区域 / CN00 / 全国(不含港澳)`，返回全国下一级管理区域表现。
- 用户说“区域”“管理区域”“大区/区域”但未明确到 `sapAreaId` 细分大区时，可以按默认管理区域排名回答，并在最终回答中写明“区域层级=管理区域”。
- 用户明确说“大区”且语义要求 `sapAreaId` 大区时，应按真正大区口径处理。
- 对层级有歧义或需要证明口径时，先用 `--full` 查看 `filters.storeTypeName`、`filters.areaName` 和返回 `code/name`。
- 如果当前 CLI 不能一条命令直接返回全国 `sapAreaId` 大区层级排名，应说明“当前 area 命令未直接返回全国 sapAreaId 大区层级排名”，不要用管理区域结果冒充大区结果。

查询全国、全品类下的区域{metric.label}表现：

```bash
source config/qdm-cli-paths.env
"$QDM_CMR_CLI" area --report company {arg} --week 2026-21
```

按当前值从高到低查看区域表现：

```bash
source config/qdm-cli-paths.env
"$QDM_CMR_CLI" area --report company {arg} --week 2026-21 --sort current --order DESC
```

如果用户已经限定了某个区域，并要求查看该区域所在层级的{metric.label}当前值，应使用 `dupont`；如果要求该父级下面的下级排名，再用 `area` 指定目标层级和父级范围。

```bash
source config/qdm-cli-paths.env
"$QDM_CMR_CLI" area --report company {arg} --week 2026-21 --area-type 督导 --area CN01 --sort current --order ASC
```

        最终回答只能使用 `area` 返回的指标值，不要把 `child-list` 清单当成{metric.label}结果。用户要求 TOPN、排名、最低或最高时，不要逐个对子区域、督导或门店执行 `dupont` 后手工排序。""",
        "followup_capabilities": f"""- 当前值查询：使用 `dupont` 查询满足过滤条件后的{metric.label}值。
- 趋势查询：使用 `trend` 查询{metric.label}按时间展开的趋势点。
- 区域表现：使用 `area` 查询{metric.label}按区域展开的表现。""",
        "primary_value_rule": f"- 当前值必须来自 `dupont` 输出中 `{metric.cli_indicator_name}` 对应返回项的 `value`，并用 `indicatorCode={metric.code}` 复核。",
    }


def render_code_filter_snippets(metric: Metric) -> dict[str, str]:
    identity = f"""- 用户展示名：{metric.label}
- 稳定指标 code：`{metric.code}`
- CLI/API 返回名可能是 `{metric.response_indicator_name}`，该名称不唯一，不能单独作为取数主键
- 当前值必须查询公司报表全量 `dupont` 结果，并只使用 `indicatorCode == "{metric.code}"` 的返回项
- 不要执行 `search indicators`，不要使用 `--indicator-name {metric.label}`、`--indicator-name {metric.response_indicator_name}` 或 `--indicator-name {metric.code}` 猜测取数"""
    return {
        "metric_identity_notes": identity,
        "current_query_description": f"查询公司报表全量结果后，按 `indicatorCode == {metric.code}` 精确取得{metric.label}值",
        "trend_query_description": f"当前 CLI 未提供按 `indicatorCode={metric.code}` 查询趋势的稳定入口",
        "area_query_description": f"当前 CLI 未提供按 `indicatorCode={metric.code}` 查询区域表现的稳定入口",
        "current_value_method": f"当前值查询使用 `dupont --report company --week <YYYY-NN>` 返回公司报表全量指标，然后只取 `indicatorCode == {metric.code}` 的那一项。该策略是{metric.label}的最短路径，因为接口返回的 `indicatorName` 可能只是 `{metric.response_indicator_name}`。当前值只查询用户显式给出的口径；未明确要求同比、环比、趋势、排名或额外对比时，不查询历史同期/上期，也不查询未提到的区域。",
        "current_value_default_command": '"$QDM_CMR_CLI" dupont --report company --week <YYYY-NN>',
        "current_value_week_example": '"$QDM_CMR_CLI" dupont --report company --week 2026-21',
        "current_value_month_example": '"$QDM_CMR_CLI" dupont --report company --month 2026-05',
        "current_value_region_example": '"$QDM_CMR_CLI" dupont --report company --week 2026-21 --area-type 管理区域 --area 粤西区',
        "current_value_area_region_example": '"$QDM_CMR_CLI" dupont --report company --week 2026-21 --area-type 大区 --area 粤东一区',
        "trend_query_block": f"""当前 CLI 不能用 `indicatorName={metric.response_indicator_name}` 唯一区分{metric.label}，因此本手册只定义{metric.label}当前值的 code 精确取数路径。

用户询问“{metric.label}趋势”“{metric.label}走势”“最近{metric.label}变化”时，不要用 `trend --indicator-name {metric.response_indicator_name}`，也不要把其它金额型指标的趋势冒充为{metric.label}趋势。应说明：当前 CLI 未提供按 `indicatorCode={metric.code}` 查询趋势的稳定入口，无法返回该指标趋势证据。""",
        "area_query_block": f"""当前 CLI 不能用 `indicatorName={metric.response_indicator_name}` 唯一区分{metric.label}，因此本手册只定义{metric.label}当前值的 code 精确取数路径。

用户询问“各区域{metric.label}”“哪个区域{metric.label}高”“区域排名”时，不要用 `area --indicator-name {metric.response_indicator_name}`，也不要把其它金额型指标的区域结果冒充为{metric.label}区域表现。应说明：当前 CLI 未提供按 `indicatorCode={metric.code}` 查询区域表现的稳定入口，无法返回该指标区域表现证据。""",
        "followup_capabilities": f"""- 当前值查询：使用 `dupont` 查询公司报表全量结果，并按 `indicatorCode == {metric.code}` 取得{metric.label}值。
- 趋势查询：当前 CLI 未提供按 `indicatorCode={metric.code}` 查询趋势的稳定入口，不主动推荐。
- 区域表现：当前 CLI 未提供按 `indicatorCode={metric.code}` 查询区域表现的稳定入口，不主动推荐。""",
        "primary_value_rule": f"- 当前值必须来自公司报表全量 `dupont` 输出中 `indicatorCode == \"{metric.code}\"` 的返回项；即使该项 `indicatorName` 是 `{metric.response_indicator_name}`，最终回答仍使用用户展示名“{metric.label}”。",
    }


def output_path(output_dir: Path, code: str) -> Path:
    return output_dir / filename(code)


def filename(code: str) -> str:
    return f"s-{slug_kebab(code)}.md"


def slug_kebab(code: str) -> str:
    first = re.sub(r"(.)([A-Z][a-z]+)", r"\1-\2", code)
    second = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", first)
    return second.replace("_", "-").lower()


def slug_snake(code: str) -> str:
    return slug_kebab(code).replace("-", "_")


def print_paths(label: str, paths: list[Path]) -> None:
    if not paths:
        return
    rels = ", ".join(str(path.relative_to(ROOT)) for path in paths[:8])
    suffix = "" if len(paths) <= 8 else f", ... (+{len(paths) - 8})"
    print(f"{label}: {rels}{suffix}")


if __name__ == "__main__":
    raise SystemExit(main())
