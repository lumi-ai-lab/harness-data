#!/usr/bin/env python3
"""镜像托管技能幂等播种：每次启动把镜像内置技能(officecli-*、charts-cli)
同步到宿主内置 ``default`` 与前缀匹配 ``harness-data-*`` 的每个 agent
workspace 并启用。

镜像把技能内容当唯一真相（与 plugin 刷新同策略）：每个目标 workspace 的
对应 ``skills/<name>`` 目录整体替换为镜像源目录下的版本，再确保该 workspace
的 ``skill.json`` 里 enabled=true。持久卷升级、运行时新建的 ``harness-data-*``
agent 都由此覆盖。任何一步无法完成都返回 78，在 QwenPaw 主进程启动前
快速失败（与 ensure_qdm_agent.py 一致）。

作用域是 ``harness-data-*`` 前缀加上宿主内置 ``default``：两者之外的内置
agent（如 QA agent）不在刷新范围。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

AGENT_PREFIX = "harness-data-"
HOST_SHARED_AGENT_ID = "default"

# 技能目录名 → 镜像内技能源目录(与 Dockerfile 构建期安装/烘焙保持同一来源)。
IMAGE_SKILLS: dict[str, str] = {
    "officecli-xlsx": "/opt/qdm/officecli-skills/officecli-xlsx",
    "officecli-docx": "/opt/qdm/officecli-skills/officecli-docx",
    "officecli-pptx": "/opt/qdm/officecli-skills/officecli-pptx",
    "charts-cli": "/opt/qdm/charts-cli-skills/charts-cli",
}


def _in_scope(agent_id: str) -> bool:
    """Whether this agent gets the image-managed skill refresh."""
    return agent_id == HOST_SHARED_AGENT_ID or agent_id.startswith(AGENT_PREFIX)


def _agent_workspace(profile: object) -> Path | None:
    """Return the profile workspace dir, or None when unreadable."""
    if not isinstance(profile, dict):
        return None
    raw = str(profile.get("workspace_dir") or "").strip()
    if not raw:
        return None
    try:
        return Path(raw).expanduser().resolve(strict=False)
    except Exception:
        return None


def main() -> int:
    working = Path(os.environ.get("QWENPAW_WORKING_DIR", "/app/working"))
    config_path = working / "config.json"

    if not config_path.is_file():
        return 0
    missing = [name for name, src in IMAGE_SKILLS.items() if not Path(src).is_dir()]
    if missing:
        print(
            f"image skill seed: source missing for: {', '.join(missing)}",
            file=sys.stderr,
        )
        return 78

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        profiles = (config.get("agents") or {}).get("profiles") or {}
    except Exception as exc:
        print(f"image skill seed: cannot read {config_path}: {exc}", file=sys.stderr)
        return 78
    if not isinstance(profiles, dict):
        print("image skill seed: agents.profiles is not an object", file=sys.stderr)
        return 78

    skill_names = tuple(sorted(IMAGE_SKILLS))
    python = sys.executable
    synced_any = False
    for agent_id, profile in sorted(profiles.items()):
        agent_id = str(agent_id or "")
        if not _in_scope(agent_id):
            continue
        workspace = _agent_workspace(profile)
        if workspace is None or not workspace.is_dir():
            print(
                f"image skill seed: skip {agent_id}: workspace missing",
                file=sys.stderr,
            )
            continue
        skills_dir = workspace / "skills"
        skills_dir.mkdir(parents=True, exist_ok=True)
        for name in skill_names:
            target = skills_dir / name
            shutil.rmtree(target, ignore_errors=True)
            shutil.copytree(Path(IMAGE_SKILLS[name]), target)
        result = subprocess.run(
            [python, "-m", "qwenpaw", "skills", "enable", *skill_names,
             "--agent-id", agent_id],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "").strip()
            print(
                f"image skill seed: enable failed for {agent_id}: {message}",
                file=sys.stderr,
            )
            return 78
        synced_any = True
        print(f"image skill seed: synced {agent_id} ({', '.join(skill_names)})")

    if not synced_any:
        print("image skill seed: no in-scope agent (harness-data-* or default) found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
