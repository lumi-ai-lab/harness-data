#!/usr/bin/env python3
"""镜像托管技能幂等播种：每次启动把镜像内置技能(officecli-*、charts-cli)
同步到宿主内置 ``default`` 与前缀匹配 ``harness-data-*`` 的每个 agent
workspace 并启用；``qdm-harness`` 只播给 ``harness-data-*``（没有 QDM 工具的
agent 装了也没意义），源取镜像刷新后的插件安装目录。

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

# QDM 技能只属于 harness-data-* agent，源在插件安装目录里；entrypoint 先整体
# 刷新插件目录再跑本脚本，所以它同样以镜像版本为唯一真相。
QDM_SKILL = "qdm-harness"
PLUGIN_ID = "qdm-harness-qwenpaw"


def _qdm_skill_source(working: Path) -> str:
    return str(working / "plugins" / PLUGIN_ID / "skills" / QDM_SKILL)


def skills_for_agent(agent_id: str, working: Path) -> dict[str, str]:
    """Skills an agent must carry, mirroring the build-time install set."""
    skills = dict(IMAGE_SKILLS)
    if agent_id != HOST_SHARED_AGENT_ID:
        skills[QDM_SKILL] = _qdm_skill_source(working)
    return skills


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


def _force_remove(path: Path) -> None:
    """Remove a tree even when it was copied from a read-only source.

    copytree preserves source mode bits, and the qdm-harness source (plugin
    skills dir) is ``chmod -R a-w``-ed by entrypoint; without the owner write
    bit on a directory the owner cannot unlink its children. Restore owner
    write/exec bits first, then remove best-effort.
    """
    if path.is_symlink() or not path.exists():
        path.unlink(missing_ok=True)
        return
    for root, dirs, files in os.walk(path, topdown=False):
        for name in files:
            file_path = os.path.join(root, name)
            try:
                mode = os.lstat(file_path).st_mode
                os.chmod(file_path, mode | 0o600, follow_symlinks=False)
            except OSError:
                pass
        try:
            mode = os.lstat(root).st_mode
            os.chmod(root, mode | 0o700)
        except OSError:
            pass
    shutil.rmtree(path, ignore_errors=True)


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

    # 先按作用域把要用到的来源查一遍再动手：半途失败会留下 default 已同步、
    # QDM agent 没同步的中间状态。
    needed: dict[str, str] = {}
    for agent_id in sorted(str(raw or "") for raw in profiles if _in_scope(str(raw or ""))):
        needed.update(skills_for_agent(agent_id, working))
    missing = [name for name, src in needed.items() if not Path(src).is_dir()]
    if missing:
        print(
            f"image skill seed: source missing for: {', '.join(missing)}",
            file=sys.stderr,
        )
        return 78

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
        skills = skills_for_agent(agent_id, working)
        skill_names = tuple(sorted(skills))
        skills_dir = workspace / "skills"
        skills_dir.mkdir(parents=True, exist_ok=True)
        for name in skill_names:
            target = skills_dir / name
            _force_remove(target)
            if target.exists():
                print(
                    f"image skill seed: cannot replace {target}",
                    file=sys.stderr,
                )
                return 78
            shutil.copytree(Path(skills[name]), target)
        # qwenpaw==2.1.0 的 skills CLI 没有 enable 子命令(后续版本才有), 走
        # 内部 API: reconcile 把磁盘技能目录登记进 skill.json(新条目默认
        # enabled=false), 再逐条 enable_skill 置位; 与 Dockerfile 构建期一致。
        try:
            from qwenpaw.agents.skill_system.registry import (  # type: ignore[import-not-found]
                reconcile_workspace_manifest,
            )
            from qwenpaw.agents.skill_system.workspace_service import (  # type: ignore[import-not-found]
                SkillService,
            )
        except Exception as exc:
            print(
                f"image skill seed: qwenpaw API import failed: {exc}",
                file=sys.stderr,
            )
            return 78
        reconcile_workspace_manifest(workspace)
        service = SkillService(workspace)
        for name in skill_names:
            result = service.enable_skill(name)
            if not result.get("success"):
                print(
                    f"image skill seed: enable failed for {agent_id}/{name}: {result}",
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
