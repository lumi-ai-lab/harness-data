#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
METRICS_JSON = ROOT / "scripts" / "cmr_business_playbook_metrics.json"
INDEX_MD = ROOT / "wikis" / "playbooks" / "cmr" / "business" / "index.md"
STATE_DIR = ROOT / ".claude" / "hooks" / "state" / "business-report"
DEFAULT_SAMPLE_PLAYBOOKS = [
    "s-sale-amt.md",
    "s-cust-num.md",
    "s-cust-penetration-rate.md",
    "s-bf19-cust-num.md",
]


def shanghai_today() -> dt.date:
    try:
        from zoneinfo import ZoneInfo

        return dt.datetime.now(ZoneInfo("Asia/Shanghai")).date()
    except Exception:
        return dt.date.today()


def parse_index(path: Path) -> dict[str, str]:
    rows: dict[str, str] = {}
    row_re = re.compile(r"^\|\s*(?P<label>[^|]+?)\s*\|\s*`(?P<file>[^`]+)`\s*\|")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = row_re.match(line)
        if not match:
            continue
        label = match.group("label").strip()
        file_name = match.group("file").strip()
        if label and label != "指标":
            rows[label] = file_name
    return rows


def load_metric_labels() -> dict[str, str]:
    metrics = json.loads(METRICS_JSON.read_text(encoding="utf-8"))
    code_to_label = {item["code"]: item["label"] for item in metrics}
    label_to_file = parse_index(INDEX_MD)
    result: dict[str, str] = {}
    for code, label in code_to_label.items():
        file_name = label_to_file.get(label)
        if file_name:
            result[file_name] = label
    return result


def project_jsonl_path(session_id: str) -> Path:
    project_key = str(ROOT).replace("/", "-")
    return Path.home() / ".claude" / "projects" / project_key / f"{session_id}.jsonl"


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if not path.exists():
        return events
    for line_no, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            payload["_line_no"] = line_no
            events.append(payload)
    return events


def parse_ts(value: object) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(normalized)
    except ValueError:
        return None


def iter_dicts(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_dicts(child)


def text_from(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict) or isinstance(value, list):
        try:
            return json.dumps(value, ensure_ascii=False)
        except TypeError:
            return str(value)
    if value is None:
        return ""
    return str(value)


def event_text(event: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("content", "text", "result"):
        if key in event:
            parts.append(text_from(event[key]))
    message = event.get("message")
    if isinstance(message, dict):
        for key in ("content", "text", "result"):
            if key in message:
                parts.append(text_from(message[key]))
    return "\n".join(part for part in parts if part)


def extract_tool_activity(events: list[dict[str, Any]]) -> tuple[list[str], list[str], list[str]]:
    commands: list[str] = []
    read_paths: list[str] = []
    tool_names: list[str] = []
    for event in events:
        for obj in iter_dicts(event):
            name = obj.get("name") or obj.get("tool_name")
            if isinstance(name, str) and (obj.get("type") == "tool_use" or "tool_input" in obj or "input" in obj):
                tool_names.append(name)
            tool_input = obj.get("tool_input")
            if not isinstance(tool_input, dict):
                tool_input = obj.get("input")
            if not isinstance(tool_input, dict):
                continue
            command = tool_input.get("command")
            if isinstance(command, str):
                commands.append(" ".join(command.split()))
            path = tool_input.get("file_path") or tool_input.get("path")
            if isinstance(path, str):
                read_paths.append(path)
    return list(dict.fromkeys(commands)), list(dict.fromkeys(read_paths)), tool_names


def first_last_timestamps(events: list[dict[str, Any]]) -> tuple[dt.datetime | None, dt.datetime | None]:
    stamps: list[dt.datetime] = []
    for event in events:
        for key in ("timestamp", "created_at", "ts"):
            stamp = parse_ts(event.get(key))
            if stamp:
                stamps.append(stamp)
                break
    return (min(stamps), max(stamps)) if stamps else (None, None)


def final_answer(events: list[dict[str, Any]]) -> str:
    for event in reversed(events):
        if event.get("type") == "result" and isinstance(event.get("result"), str):
            return " ".join(event["result"].split())
        message = event.get("message")
        if isinstance(message, dict) and message.get("role") == "assistant":
            text = event_text(event)
            if text and "tool_use" not in text:
                return " ".join(text.split())
    return ""


def markdown_escape(value: object) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "\\|").replace("\n", "<br>")


def expected_cli(label: str, date_value: str) -> str:
    return f"dupont --report business --indicator-name {label} --date {date_value}"


def classify(
    *,
    label: str,
    playbook_file: str,
    date_value: str,
    state: dict[str, Any],
    events: list[dict[str, Any]],
    commands: list[str],
    read_paths: list[str],
) -> tuple[str, str, str, list[str]]:
    selected = str(state.get("selected_playbook") or "")
    target_selected = f"playbooks/cmr/business/{playbook_file}"
    target_wiki = f"wikis/playbooks/cmr/business/{playbook_file}"
    all_text = "\n".join(event_text(event) for event in events)
    read_target = any(target_wiki in path or target_selected in path for path in read_paths) or target_wiki in all_text or target_selected in all_text
    template_injected = bool(state.get("template_injected")) or any("inject-template" in cmd for cmd in commands)
    selected_ok = selected == target_selected

    cli_commands = [cmd for cmd in commands if "data-harness-cli" in cmd or "QDM_CMR_CLI" in cmd or " dupont " in f" {cmd} "]
    dupont_current = [
        cmd
        for cmd in cli_commands
        if "dupont" in cmd
        and "--report business" in cmd
        and f"--indicator-name {label}" in cmd
        and f"--date {date_value}" in cmd
    ]
    final = final_answer(events)
    answered_with_evidence = bool(dupont_current and final)

    playbook_reasons: list[str] = []
    shortest_reasons: list[str] = []
    if template_injected:
        playbook_reasons.append("执行了 inject-template")
    if not selected_ok:
        playbook_reasons.append(f"selected_playbook={selected or '空'}")
    if not read_target:
        playbook_reasons.append("未观察到读取目标 playbook")
    if not dupont_current:
        playbook_reasons.append("未观察到目标 dupont 当前值命令")
    if not answered_with_evidence:
        playbook_reasons.append("最终答案证据不够清晰")

    if template_injected or not selected_ok or not dupont_current:
        playbook_status = "FAIL"
    elif not read_target or not answered_with_evidence:
        playbook_status = "WARN"
    else:
        playbook_status = "PASS"

    search_commands = [cmd for cmd in cli_commands if re.search(r"\bsearch\b", cmd)]
    duplicate_dupont = len([cmd for cmd in cli_commands if "dupont" in cmd]) > 1
    full_commands = [cmd for cmd in cli_commands if "--full" in cmd]
    fail_commands = [
        cmd
        for cmd in cli_commands
        if re.search(r"\barea\b|\btrend\b|report business category|report business overview|legacy", cmd)
    ]
    if not dupont_current:
        shortest_reasons.append("未使用唯一目标 dupont 当前值命令")
    if fail_commands:
        shortest_reasons.append("出现趋势/区域/品类/overview/legacy 路径")
    if search_commands:
        shortest_reasons.append("存在无必要 search")
    if duplicate_dupont:
        shortest_reasons.append("重复执行 dupont")
    if full_commands:
        shortest_reasons.append("存在额外 --full")

    if fail_commands or not dupont_current:
        shortest_status = "FAIL"
    elif search_commands or duplicate_dupont or full_commands or len(cli_commands) > 1:
        shortest_status = "WARN"
        if len(cli_commands) > 1 and not shortest_reasons:
            shortest_reasons.append("存在额外 CLI 命令")
    else:
        shortest_status = "PASS"

    if playbook_status == "PASS" and shortest_status == "PASS":
        optimization = "否"
    elif playbook_status == "FAIL" or shortest_status == "FAIL":
        optimization = "需要优化"
    else:
        optimization = "建议观察"

    reasons = playbook_reasons + shortest_reasons
    return playbook_status, shortest_status, optimization, reasons


def run_one(label: str, playbook_file: str, out_dir: Path, current_date: str, yesterday: str) -> dict[str, Any]:
    session_id = str(uuid.uuid4())
    prompt = f"昨天{label}是多少?"
    stream_path = out_dir / f"{playbook_file.removesuffix('.md')}.stream.jsonl"
    state_path = STATE_DIR / f"{session_id}.json"
    persistent_path = project_jsonl_path(session_id)
    env = os.environ.copy()
    env.update(
        {
            "QDM_HARNESS_DIAG": "1",
            "QDM_HARNESS_CURRENT_DATE": current_date,
            "QDM_HARNESS_TIMEZONE": "Asia/Shanghai",
        }
    )
    cmd = [
        "claude",
        "--settings",
        str(Path.home() / ".config" / "claude" / "settings.ds.json"),
        "--setting-sources",
        "user,project,local",
        "--dangerously-skip-permissions",
        "--session-id",
        session_id,
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--include-hook-events",
        prompt,
    ]
    started = time.monotonic()
    with stream_path.open("w", encoding="utf-8") as stdout_file:
        proc = subprocess.run(
            cmd,
            cwd=ROOT,
            env=env,
            stdout=stdout_file,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
    wall_seconds = time.monotonic() - started

    stream_events = load_jsonl(stream_path)
    persistent_events = load_jsonl(persistent_path)
    events = stream_events or persistent_events
    commands, read_paths, tool_names = extract_tool_activity(events)
    state: dict[str, Any] = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            state = {}
    first_ts, last_ts = first_last_timestamps(stream_events)
    duration = (last_ts - first_ts).total_seconds() if first_ts and last_ts else wall_seconds
    playbook_status, shortest_status, optimization, reasons = classify(
        label=label,
        playbook_file=playbook_file,
        date_value=yesterday,
        state=state,
        events=events,
        commands=commands,
        read_paths=read_paths,
    )
    if proc.returncode != 0:
        playbook_status = "FAIL"
        shortest_status = "FAIL"
        optimization = "需要优化"
        reasons.append(f"claude exit={proc.returncode}: {proc.stderr.strip()[:300]}")

    return {
        "label": label,
        "playbook_file": playbook_file,
        "target_playbook": f"playbooks/cmr/business/{playbook_file}",
        "prompt": prompt,
        "session_id": session_id,
        "stream_path": stream_path,
        "persistent_path": persistent_path,
        "state_path": state_path,
        "selected_playbook": state.get("selected_playbook", ""),
        "commands": commands,
        "read_paths": read_paths,
        "tool_names": tool_names,
        "answer": final_answer(events),
        "duration": duration,
        "playbook_status": playbook_status,
        "shortest_status": shortest_status,
        "optimization": optimization,
        "reasons": reasons,
    }


def write_summary(results: list[dict[str, Any]], out_dir: Path) -> None:
    lines: list[str] = []
    lines.append("# CMR Business Playbook 抽样测试报告")
    lines.append("")
    lines.append(f"- 运行目录：`{out_dir}`")
    lines.append(f"- 样本数：{len(results)}")
    lines.append("")
    lines.append("| 指标Playbook | 是否按Playbook运行 | 按照PlayBook的命令是否是最短路径 | 输出答案用时(秒) | PlayBook是否需要优化 |")
    lines.append("| --- | --- | --- | ---: | --- |")
    for item in results:
        playbook = f"`{item['playbook_file']}`（{item['label']}）"
        lines.append(
            "| {playbook} | {playbook_status} | {shortest_status} | {duration:.1f} | {optimization} |".format(
                playbook=markdown_escape(playbook),
                playbook_status=markdown_escape(item["playbook_status"]),
                shortest_status=markdown_escape(item["shortest_status"]),
                duration=float(item["duration"]),
                optimization=markdown_escape(item["optimization"]),
            )
        )
    fail_warn = [item for item in results if item["reasons"]]
    if fail_warn:
        lines.append("")
        for item in fail_warn:
            lines.append(
                f"- `{item['playbook_file']}`：{markdown_escape('；'.join(dict.fromkeys(item['reasons'])))}"
            )
    lines.append("")
    lines.append("## 人工复核证据")
    for item in results:
        lines.append("")
        lines.append(f"### {item['label']} / `{item['playbook_file']}`")
        lines.append("")
        lines.append(f"- prompt：`{markdown_escape(item['prompt'])}`")
        lines.append(f"- session id：`{item['session_id']}`")
        lines.append(f"- selected playbook：`{markdown_escape(item['selected_playbook'])}`")
        lines.append(f"- stream JSONL：`{item['stream_path']}`")
        lines.append(f"- Claude persistent JSONL：`{item['persistent_path']}`")
        lines.append(f"- hook state：`{item['state_path']}`")
        if item["commands"]:
            lines.append("- 实际 Bash/CLI 命令序列：")
            for command in item["commands"]:
                lines.append(f"  - `{markdown_escape(command)}`")
        else:
            lines.append("- 实际 Bash/CLI 命令序列：未观察到")
        answer = item["answer"] or "未提取到最终答案"
        lines.append(f"- 最终答案摘要：{markdown_escape(answer[:500])}")
        reason_text = "；".join(dict.fromkeys(item["reasons"])) if item["reasons"] else "无"
        lines.append(f"- WARN/FAIL 原因：{markdown_escape(reason_text)}")
    (out_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run CMR business single-playbook smoke tests through Claude Code.")
    parser.add_argument("--current-date", default=shanghai_today().isoformat(), help="Harness current date, default Asia/Shanghai today.")
    parser.add_argument("--output-root", type=Path, default=ROOT / "runs" / "cmr-business-playbook-smoke")
    parser.add_argument("--playbook", action="append", help="Sample playbook file name. Can be passed multiple times.")
    args = parser.parse_args()

    try:
        current_date = dt.date.fromisoformat(args.current_date)
    except ValueError as exc:
        raise SystemExit(f"invalid --current-date: {args.current_date}") from exc
    yesterday = (current_date - dt.timedelta(days=1)).isoformat()

    file_to_label = load_metric_labels()
    sample_files = args.playbook or DEFAULT_SAMPLE_PLAYBOOKS
    missing = [file_name for file_name in sample_files if file_name not in file_to_label]
    if missing:
        raise SystemExit(f"missing playbook label mapping: {', '.join(missing)}")

    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = args.output_root / timestamp
    out_dir.mkdir(parents=True, exist_ok=False)

    results: list[dict[str, Any]] = []
    for file_name in sample_files:
        label = file_to_label[file_name]
        print(f"running {file_name} ({label})", file=sys.stderr, flush=True)
        results.append(run_one(label, file_name, out_dir, current_date.isoformat(), yesterday))
        write_summary(results, out_dir)

    session_ids = [item["session_id"] for item in results]
    if len(session_ids) != len(set(session_ids)):
        raise SystemExit("duplicate session ids detected")
    write_summary(results, out_dir)
    print(out_dir / "summary.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
