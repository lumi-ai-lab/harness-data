#!/usr/bin/env python3
"""Inventory deleted Wiki objects and compare them with qdm-metric-cli Registry.

This script is intentionally read-only with respect to the Wiki repository.
It reads historical files with `git show`, reads current manifests, invokes
`qdm-metric-cli metric search`, and writes an analysis report outside the Wiki
tree when --output is provided.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path


def run(*args: str, cwd: Path) -> str:
    return subprocess.check_output(args, cwd=cwd, text=True)


def git_deleted(repo: Path, ref: str, prefix: str) -> list[str]:
    output = run(
        "git",
        "-c",
        "core.quotePath=false",
        "diff",
        "--name-only",
        "--diff-filter=D",
        ref,
        "--",
        prefix,
        cwd=repo,
    )
    return [line for line in output.splitlines() if line]


def git_file(repo: Path, ref: str, path: str) -> str:
    return run("git", "show", f"{ref}:{path}", cwd=repo)


def manifest_codes(path: Path) -> set[str]:
    values = json.loads(path.read_text())
    return {value if isinstance(value, str) else value["code"] for value in values}


def frontmatter(text: str, key: str) -> str:
    if not text.startswith("---"):
        return ""
    block = text.split("---", 2)[1]
    match = re.search(rf"^{re.escape(key)}:\s*[\"']?([^\"'\n]+)", block, re.MULTILINE)
    return match.group(1).strip() if match else ""


def deleted_metrics(repo: Path, ref: str) -> list[dict[str, str]]:
    paths = git_deleted(repo, ref, "metrics")
    dirs = sorted({path.rsplit("/", 1)[0] for path in paths if path.endswith("/spec.md")})
    rows: list[dict[str, str]] = []
    for directory in dirs:
        spec = git_file(repo, ref, f"{directory}/spec.md")
        rows.append(
            {
                "directory": directory,
                "label": frontmatter(spec, "label"),
                "old_code": frontmatter(spec, "name"),
            }
        )
    return rows


def deleted_reports(repo: Path, ref: str) -> list[str]:
    return sorted(
        {
            path.split("/", 2)[1]
            for path in git_deleted(repo, ref, "reports")
            if path.count("/") >= 2
        }
    )


def deleted_dims(repo: Path, ref: str) -> list[str]:
    return sorted(
        {
            path.split("/", 2)[1]
            for path in git_deleted(repo, ref, "dims")
            if path.count("/") >= 2
        }
    )


def report_codes(repo: Path, ref: str, report: str, registry: set[str], composites: set[str]) -> tuple[list[str], list[str]]:
    # Read the Spec tables only. Playbooks/templates also contain placeholder
    # variables and SQL aliases that are not Metric codes.
    text = git_file(repo, ref, f"reports/{report}/spec.md")
    codes = sorted(set(re.findall(r"\|\s*`([A-Za-z][A-Za-z0-9_]*)`\s*\|", text)))
    supported = sorted(set(codes) & (registry | composites))
    missing = sorted(set(codes) - (registry | composites))
    return supported, missing


def md_list(values: list[str]) -> str:
    return "\n".join(f"- `{value}`" for value in values) if values else "- 无"


def build_report(repo: Path, ref: str, cli: Path) -> str:
    version = json.loads(run(str(cli), "version", "--output", "envelope", cwd=repo))
    registry_payload = json.loads(run(str(cli), "metric", "search", "--limit", "500", "--output", "envelope", cwd=repo))
    registry_rows = registry_payload["data"]
    registry = {row["code"]: row for row in registry_rows}
    direct = manifest_codes(repo / "scripts/indicators-manifest.json")
    composites = {
        row["code"]
        for row in json.loads((repo / "scripts/indicators-composite-manifest.json").read_text())
    }
    union = direct | composites
    deleted = deleted_metrics(repo, ref)
    deleted_reports_list = deleted_reports(repo, ref)
    deleted_dims_list = deleted_dims(repo, ref)
    registry_by_name = {row.get("name"): row["code"] for row in registry_rows if row.get("name")}
    rendered_codes = set()
    for path in sorted((repo / "metrics").glob("*/spec.md")):
        content = path.read_text(encoding="utf-8")
        rendered_codes.update(re.findall(r"(?:metrics|indicators)\.code\.([A-Za-z0-9_]+)", content))
    manifest_not_rendered = sorted(union - rendered_codes)

    exact = sorted(row["old_code"] for row in deleted if row["old_code"] in registry)
    renamed = sorted(
        (row["old_code"], registry_by_name[row["label"]])
        for row in deleted
        if row["old_code"] not in registry and row["label"] in registry_by_name
    )
    unsupported = sorted(
        row["old_code"]
        for row in deleted
        if row["old_code"] not in registry and row["label"] not in registry_by_name
    )

    report_rows: list[str] = []
    for report in deleted_reports_list:
        supported, missing = report_codes(repo, ref, report, set(registry), composites)
        report_rows.append(
            f"| `{report}` | {len(supported)} | {len(missing)} | "
            f"{', '.join(f'`{code}`' for code in missing) if missing else '-'} |"
        )

    lines = [
        "# qdm-metric-cli Wiki 恢复旁路分析",
        "",
        f"- 分析基准：`{ref}`",
        f"- CLI：`{cli}`",
        f"- CLI 版本：`{version['version']}`",
        f"- Registry release：`{version['registryRelease']}`",
        f"- Registry content hash：`{version['registryContentHash']}`",
        "",
        "## 删除清单统计",
        "",
        f"- 删除 Metric 目录：{len(deleted)}（{len(deleted) * 3} 个 spec/playbook/index 文件）",
        f"- 删除 Report 目录：{len(deleted_reports_list)}（每个 4 个文件）",
        f"- 删除 Dim 目录：{len(deleted_dims_list)}（每个 2 个文件）",
        "",
        "### 删除 Report",
        "",
        md_list(deleted_reports_list),
        "",
        "### 删除 Dim",
        "",
        md_list(deleted_dims_list),
        "",
        "## Metric 删除与 Registry 对账",
        "",
        f"- 当前 Registry：{len(registry)}",
        f"- direct manifest：{len(direct)}",
        f"- composite manifest：{len(composites)}",
        f"- Wiki manifest union：{len(union)}",
        f"- Registry 未进入 Wiki union：{len(set(registry) - union)}",
        f"- Wiki union 不在 Registry：{len(union - set(registry))}",
        f"- manifest union 尚未渲染到当前 Metric 文档：{len(manifest_not_rendered)}",
        "",
        "### manifest 已纳入但当前文档目录尚未渲染",
        "",
        md_list(manifest_not_rendered),
        "",
        "### 删除文档旧 code 仍存在于当前 Registry",
        "",
        md_list(exact),
        "",
        "### 删除文档同名但 code 已迁移",
        "",
    ]
    lines.extend(
        f"- `{old}` -> `{new}`（{next(row['label'] for row in deleted if row['old_code'] == old)}）"
        for old, new in renamed
    )
    lines.extend(
        [
            "",
            "## 删除 Metric 文档完整清单",
            "",
            "| 目录 | 历史 code | 历史标题 | 当前判断 |",
            "| --- | --- | --- | --- |",
        ]
    )
    for row in deleted:
        if row["old_code"] in registry:
            status = f"当前 Registry 仍存在：`{row['old_code']}`"
        elif row["label"] in registry_by_name:
            status = f"同名迁移到：`{registry_by_name[row['label']]}`"
        else:
            status = "当前 Registry 无 code/同名替代"
        lines.append(
            f"| `{row['directory']}` | `{row['old_code']}` | {row['label'] or '-'} | {status} |"
        )
    lines.extend(
        [
            "",
            "### 删除文档当前无 Registry code 或同名替代",
            "",
            md_list(unsupported),
            "",
            "## 当前 Registry 尚未进入 Wiki union",
            "",
            md_list(sorted(set(registry) - union)),
            "",
            "## 删除 Report 的 code 覆盖",
            "",
            "| Report | 当前 Registry/Composite code 数 | 缺失 code 数 | 缺失 code |",
            "| --- | ---: | ---: | --- |",
        ]
    )
    lines.extend(report_rows)
    lines.extend(
        [
            "",
            "## 结论",
            "",
            "该报告是只读盘点结果，不执行恢复。Metric 恢复必须以 wikis 元数据成功、真实 analysis execute 成功、"
            "参数/维度/统计策略/输出契约均迁移完成为准；仅 Registry 存在不能证明可恢复。",
            "",
            "可复用流程：",
            "",
            "```text",
            "git diff --name-only --diff-filter=D HEAD -- metrics reports dims",
            "git show HEAD:metrics/<dir>/spec.md -> 读取历史 frontmatter name/label",
            "qdm-metric-cli metric search --limit 500 --output envelope",
            "qdm-metric-cli wikis --code <code> --output envelope",
            "qdm-metric-cli analysis execute ... --output envelope",
            "registry_codes - (direct_manifest_codes union composite_codes)",
            "```",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = build_report(args.repo.resolve(), args.ref, args.cli.resolve())
    if args.output:
        args.output.write_text(report)
    else:
        print(report)


if __name__ == "__main__":
    main()
