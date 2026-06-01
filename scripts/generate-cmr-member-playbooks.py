#!/usr/bin/env python3
"""Generate CMR member single-metric playbooks from a JSON manifest."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "scripts" / "cmr_member_playbook_metrics.json"
DEFAULT_TEMPLATE = ROOT / "scripts" / "templates" / "cmr_member_single_playbook.md.j2"
SPEC_DIR = ROOT / "wikis" / "spec" / "cmr" / "member"
PLAYBOOK_DIR = ROOT / "wikis" / "playbooks" / "cmr" / "member"


@dataclass(frozen=True)
class Metric:
    label: str
    code: str
    aliases: tuple[str, ...]


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
        metrics.append(Metric(label=label, code=code, aliases=tuple(value.strip() for value in aliases)))
    return metrics


def required_str(item: dict[str, Any], key: str, index: int) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"manifest item #{index} requires non-empty string field {key!r}")
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
    values = {
        "frontmatter_name": f"playbook_cmr_member_s_{slug_snake(metric.code)}",
        "label": metric.label,
        "code": metric.code,
        "alias_phrase": f"、{aliases}" if aliases else "",
    }
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{ " + key + " }}", value)
    if "{{" in rendered or "}}" in rendered:
        raise ValueError("template contains unresolved placeholder(s)")
    return rendered if rendered.endswith("\n") else rendered + "\n"


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
