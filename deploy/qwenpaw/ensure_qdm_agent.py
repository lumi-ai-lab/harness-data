#!/usr/bin/env python3
"""引导并维护 QDM 专用 Agent，构建期与每次容器启动都执行，幂等。

镜像把 QDM 职责放在一个符合 `harness-data-*` 约定的专用 Agent 上，而不是宿主
内置的 `default`。只改镜像不够：持久卷里的 config.json 仅在缺失时才从 seed 复制，
老部署升级镜像后既不会多出这个 Agent，渠道也还绑在 `default` 上。本脚本负责：

1. Agent 缺失时创建它（走宿主自己的 `agents create`，避免手抄它那份 25KB 的
   默认配置）；
2. 把 `default` 上已启用的 QDM 渠道**搬移**过来。必须是搬移而不是复制：每一个
   enabled 的 Agent workspace 都会启动自己的渠道管理器，两个 Agent 同时持有同
   一份企微/飞书凭证就是双份连接、消息被消费两次；
3. `active_agent` 仍是未被改动过的 `default` 时，把它指到新 Agent；运维改过的
   选择一律保留，与 align_timezone.py 同样的"只修正未动过的默认值"约定；
4. 把该 Agent 的工具面收窄到 strict 白名单（3 个工具 + 关工具结果裁剪）。
   收窄由插件 setup 在**构建期**施加到 seed；持久卷升级时本脚本运行期新建的
   Agent 不会带上 seed 的工具面，于是每次启动幂等重放，保住"模型没有文件与
   命令工具可用"这条 QDM 授权边界。

任何一步无法完成都返回退出码 78，在 QwenPaw 主进程启动前快速失败。
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile


DEFAULT_QDM_AGENT_ID = "harness-data-default"
LEGACY_SHARED_AGENT_ID = "default"
QDM_AGENT_NAME = "QDM 数据助手"
# 插件只从这两个渠道解析请求身份，所以只搬这两个；`console` 尤其要留在原处，
# 否则运维在 Web 控制台里连自己的 Agent 都聊不了。
MANAGED_CHANNEL_NAMES = ("wecom", "feishu")
# strict 策略下 QDM Agent 允许保留的内置工具。与插件侧 ALLOWED_TOOLS
# (.agents/qwenpaw/install-qwenpaw-plugin.py) 保持一致; doctor 按同一份清单
# 校验, 漂移会直接报 offenders。
STRICT_ALLOWED_TOOLS = ("qdm_query", "qdm_scope_summary", "get_current_time")


def apply_strict_tool_policy(agent_json_path: str) -> bool:
    """把某 Agent 的工具面收窄到 strict 白名单, 有改动返回 True。

    副作用与插件 `_configure_allowlist` 一致: 关掉工具结果裁剪
    (light_context_config.tool_result_pruning_config), 并且 builtin_tools 里
    只有白名单内的工具允许启用。只改 enabled 位与裁剪开关, 不增删工具条目、
    不动其他配置; 幂等, 无改动时不重写文件(避免每次启动的写放大)。
    """
    with open(agent_json_path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise RuntimeError(f"agent config is not a JSON object: {agent_json_path}")

    light = data.setdefault("light_context_config", {})
    if not isinstance(light, dict):
        raise RuntimeError("agent.json light_context_config 配置无效")
    pruning = light.setdefault("tool_result_pruning_config", {})
    if not isinstance(pruning, dict):
        raise RuntimeError("agent.json tool_result_pruning_config 配置无效")

    tools = data.setdefault("tools", {})
    if not isinstance(tools, dict):
        raise RuntimeError("agent.json tools 配置无效")
    builtin = tools.setdefault("builtin_tools", {})
    if not isinstance(builtin, dict):
        raise RuntimeError("agent.json tools.builtin_tools 配置无效")

    changed = False
    if pruning.get("enabled") is not False:
        pruning["enabled"] = False
        changed = True
    allow = set(STRICT_ALLOWED_TOOLS)
    for name, entry in builtin.items():
        # 与插件 _configure_allowlist 一致: 显式归一化每个条目的 enabled 位
        # (含补全缺省键), 而不是只改写有差异的条目。
        if isinstance(entry, dict):
            entry["enabled"] = name in allow
            changed = True

    if not changed:
        return False

    # 无差异时不落盘: 逐字节比较序列化结果, 避免每次启动都重写文件。
    serialized = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    with open(agent_json_path, encoding="utf-8") as handle:
        if handle.read() == serialized:
            return False

    mode = os.stat(agent_json_path).st_mode & 0o7777
    fd, temp_path = tempfile.mkstemp(dir=os.path.dirname(agent_json_path), prefix=".agent.json.", text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
        os.chmod(temp_path, mode)
        os.replace(temp_path, agent_json_path)
    except BaseException:
        os.unlink(temp_path)
        raise
    return True


def qdm_agent_id() -> str:
    value = os.environ.get("QWENPAW_QDM_AGENT_ID", DEFAULT_QDM_AGENT_ID).strip()
    return value or DEFAULT_QDM_AGENT_ID


def channel_enabled(channels: object, name: str) -> bool:
    """Read ``channels.<name>.enabled``; absent config blocks read as disabled.

    ``load_agent_config`` always hands back the host's ``ChannelConfig`` model,
    whose per-channel members are themselves models. A missing channel (an
    older agent.json, or ``channels`` being None) simply is not enabled.
    """
    channel = getattr(channels, name, None)
    return bool(getattr(channel, "enabled", False))


def plan_channel_moves(source: object, target: object) -> tuple[list[str], list[str]]:
    """Return ``(moveable, conflicting)`` managed channels.

    A channel enabled on both sides is only reported, never touched: switching
    one side off silently would drop a bot the operator is relying on right now.
    """
    moveable: list[str] = []
    conflicting: list[str] = []
    for name in MANAGED_CHANNEL_NAMES:
        if channel_enabled(source, name):
            if channel_enabled(target, name):
                conflicting.append(name)
            else:
                moveable.append(name)
    return moveable, conflicting


def apply_channel_moves(source: object, target: object, names: list[str]) -> None:
    """Move *names* out of *source* and into *target*, in place."""
    for name in names:
        moved = copy.deepcopy(getattr(source, name))
        moved.enabled = True
        setattr(target, name, moved)
        getattr(source, name).enabled = False


def _create_agent(agent_id: str) -> None:
    command = [sys.executable, "-m", "qwenpaw", "agents", "create",
               "--name", QDM_AGENT_NAME, "--agent-id", agent_id]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        lines = (result.stderr or result.stdout or "").strip().splitlines()
        raise RuntimeError(f"agents create failed: {lines[-1] if lines else 'no output'}")


def ensure() -> list[str]:
    """Bring the QDM agent into existence and adopt a legacy channel binding.

    Returns the human-readable list of actions taken.
    """
    agent_id = qdm_agent_id()
    if agent_id == LEGACY_SHARED_AGENT_ID:
        raise RuntimeError("QWENPAW_QDM_AGENT_ID must not be the host's shared default agent")

    from qwenpaw.config.config import load_agent_config, save_agent_config
    from qwenpaw.config.utils import load_config, save_config

    actions: list[str] = []

    if agent_id not in load_config().agents.profiles:
        _create_agent(agent_id)
        if agent_id not in load_config().agents.profiles:
            raise RuntimeError(f"agent {agent_id} is still missing after creation")
        if not os.path.isdir(os.path.join(os.environ.get("QWENPAW_WORKING_DIR", ""), "workspaces", agent_id)):
            raise RuntimeError(f"workspace for {agent_id} was not created")
        actions.append(f"created agent {agent_id}")

    target = load_agent_config(agent_id)
    if LEGACY_SHARED_AGENT_ID in load_config().agents.profiles:
        legacy = load_agent_config(LEGACY_SHARED_AGENT_ID)
        moveable, conflicting = plan_channel_moves(legacy.channels, target.channels)
        for name in conflicting:
            actions.append(f"left {name} enabled on both {LEGACY_SHARED_AGENT_ID} and {agent_id}; "
                           "disable one of them or the bot connects twice")
        if moveable:
            apply_channel_moves(legacy.channels, target.channels, moveable)
            save_agent_config(LEGACY_SHARED_AGENT_ID, legacy)
            save_agent_config(agent_id, target)
            actions.append(f"moved {', '.join(moveable)} from {LEGACY_SHARED_AGENT_ID} to {agent_id}")

    config = load_config()
    if config.agents.active_agent == LEGACY_SHARED_AGENT_ID:
        config.agents.active_agent = agent_id
        save_config(config)
        actions.append(f"active_agent -> {agent_id}")

    # 工具收窄放在最后: 上面的 agents create / save_agent_config 都会重写
    # agent.json, 收窄要作用在最终落盘的内容上。构建期 seed 尚未生成时这里照跑,
    # 由随后的插件 setup 覆盖成一致状态, 幂等无副作用。
    agent_json = os.path.join(
        os.environ.get("QWENPAW_WORKING_DIR", ""), "workspaces", agent_id, "agent.json",
    )
    if os.path.isfile(agent_json) and apply_strict_tool_policy(agent_json):
        actions.append(f"narrowed tools of {agent_id} to the QDM strict allowlist")

    for action in actions:
        print(f"qdm agent bootstrap: {action}")
    return actions


def main() -> int:
    try:
        ensure()
    except Exception as exc:  # fail closed before the app starts
        print(f"QDM agent bootstrap failed: {exc}", file=sys.stderr)
        return 78
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
