"""QwenPaw QDM plugin install, doctor and uninstall entry point."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from typing import Any

from qdm_config import (
    ConfigError,
    DEFAULT_PLUGIN_CONFIG_FILE,
    DEFAULT_QDM_AGENT_ID,
    parse_context_limits,
    parse_query_limits,
    parse_report_limits,
    sensitive_material_paths,
    TOOL_POLICIES,
)


PLUGIN_ID = "qdm-harness-qwenpaw"
ALLOWED_TOOLS = {
    "qdm_query": "执行受限的 QDM 指标查询；只接受 analysis execute 之后的业务参数。",
    "qdm_scope_summary": "返回当前渠道用户的脱敏 QDM 数据权限摘要。",
    "get_current_time": "获取当前时间，用于相对日期计算。",
}


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        args.working_dir = str(_resolve_working_dir(args.python, args.working_dir))
        {"install": install, "doctor": doctor, "uninstall": uninstall}[args.command](args)
        return 0
    except RuntimeError as exc:
        print(f"QwenPaw QDM 插件失败：{exc}", file=sys.stderr)
        return 1


def install(args: argparse.Namespace) -> None:
    source = Path(args.source).resolve()
    runtime = _runtime(args.runtime)
    _validate_source(source)
    _validate_qwenpaw(args.python, args.working_dir)
    auth_file, secret_file = _sensitive_material_paths(runtime)
    _validate_channel_auth(auth_file)
    _validate_regular(secret_file, "会话 HMAC Secret", minimum=32)
    _validate_runtime_binaries(runtime)
    config = {
        "schema_version": 1,
        "runtime_dir": str(runtime),
        "qdm_agent_id": args.agent_id,
        "user_id_display_mode": args.user_id_display_mode,
        "tool_policy": getattr(args, "tool_policy", "preserve"),
        "context_limits": {
            "base_context_bytes": None,
            "wiki_file_bytes": None,
            "wiki_total_bytes": None,
        },
        "query_limits": {"success_bytes": None, "timeout_seconds": 120},
        "report_limits": {"additional_context_bytes": None},
    }
    agent = _agent_file(args.working_dir, args.agent_id, args.agent_config)
    original_agent = agent.read_bytes()
    original_plugin_config = (
        DEFAULT_PLUGIN_CONFIG_FILE.read_bytes()
        if DEFAULT_PLUGIN_CONFIG_FILE.is_file()
        and not DEFAULT_PLUGIN_CONFIG_FILE.is_symlink()
        else None
    )
    try:
        _write_json(DEFAULT_PLUGIN_CONFIG_FILE, config)
        _configure_allowlist(agent, getattr(args, "tool_policy", "preserve"))
        _run_qwenpaw(args.python, args.working_dir, ["plugin", "validate", str(source)])
        _run_qwenpaw(args.python, args.working_dir, ["plugin", "install", str(source), "--force"])
    except Exception:
        _write_bytes(agent, original_agent)
        if original_plugin_config is None:
            DEFAULT_PLUGIN_CONFIG_FILE.unlink(missing_ok=True)
        else:
            _write_bytes(DEFAULT_PLUGIN_CONFIG_FILE, original_plugin_config)
        raise
    print(f"QwenPaw QDM 插件已安装：{PLUGIN_ID}")
    print(f"QwenPaw 工作目录：{args.working_dir}")
    if args.user_id_display_mode == "command":
        print("警告：原始 UserID 调试回显仅限受控测试，群聊对成员可见。")


def doctor(args: argparse.Namespace) -> None:
    failures = []
    runtime = _runtime(args.runtime)
    agent = _agent_file(args.working_dir, args.agent_id, args.agent_config)
    checks = (
        ("QwenPaw 2.1.x / Runtime Hook API", lambda: _validate_qwenpaw(args.python, args.working_dir)),
        ("Harness / QDM CLI", lambda: _validate_runtime_binaries(runtime)),
        ("渠道授权文件", lambda: _validate_channel_auth(_sensitive_material_paths(runtime)[0])),
        ("会话 HMAC Secret", lambda: _validate_regular(_sensitive_material_paths(runtime)[1], "会话 HMAC Secret", minimum=32)),
        ("QDM Agent 工具白名单", lambda: _verify_allowlist(agent, _configured_tool_policy())),
        ("插件配置", lambda: _verify_plugin_config(runtime, args.agent_id)),
    )
    for label, check in checks:
        try:
            check()
            print(f"PASS {label}")
        except RuntimeError as exc:
            failures.append(label)
            print(f"FAIL {label}: {exc}")
    try:
        mode = _read_json(DEFAULT_PLUGIN_CONFIG_FILE)["user_id_display_mode"]
        print(f"PASS 调试回显：{mode}")
        if mode == "command":
            print("WARN 仅限受控测试，须完成宿主日志/会话泄露回归。")
    except (KeyError, RuntimeError) as exc:
        failures.append("调试回显")
        print(f"FAIL 调试回显: {exc}")
    if failures:
        raise RuntimeError("doctor 未通过")


def uninstall(args: argparse.Namespace) -> None:
    _validate_qwenpaw(args.python, args.working_dir)
    result = subprocess.run(
        [args.python, "-m", "qwenpaw", "plugin", "uninstall", PLUGIN_ID],
        input="y\n",
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        env=_env(args.working_dir),
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError("QwenPaw 插件卸载失败")
    print(f"QwenPaw QDM 插件已卸载：{PLUGIN_ID}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("install", "doctor", "uninstall"))
    parser.add_argument("--source", default=str(Path(__file__).parent))
    parser.add_argument("--runtime")
    parser.add_argument("--qwenpaw-python", dest="python", default=sys.executable)
    parser.add_argument("--qwenpaw-working-dir", dest="working_dir", default="")
    parser.add_argument("--agent-id", default=DEFAULT_QDM_AGENT_ID)
    parser.add_argument("--agent-config", default="")
    parser.add_argument("--user-id-display-mode", default="off", choices=("off", "command"))
    parser.add_argument("--tool-policy", default="preserve", choices=tuple(sorted(TOOL_POLICIES)))
    return parser


def _validate_source(source: Path) -> None:
    if not (source / "plugin.json").is_file() or not (source / "plugin.py").is_file():
        raise RuntimeError("插件源码不完整")


def _validate_qwenpaw(python: str, working_dir: str) -> None:
    code = "import importlib.metadata; from qwenpaw.plugins.api import PluginApi; v=importlib.metadata.version('qwenpaw'); assert v.startswith('2.1.'),v; assert callable(getattr(PluginApi,'register_runtime_hook_now',None))"
    result = subprocess.run(
        [python, "-c", code], shell=False, env=_env(working_dir), capture_output=True,
    )
    if result.returncode:
        raise RuntimeError("需要具备 register_runtime_hook_now() 的 QwenPaw 2.1.x")


def _resolve_working_dir(python: str, explicit: str) -> Path:
    """Use the selected QwenPaw installation's exact WORKING_DIR semantics."""
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_absolute() or path.is_symlink():
            raise RuntimeError("--qwenpaw-working-dir 必须是非符号链接的绝对路径")
        return path.resolve()
    try:
        result = subprocess.run(
            [python, "-c", "from qwenpaw.constant import WORKING_DIR; print(WORKING_DIR)"],
            shell=False,
            env=dict(os.environ),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError as exc:
        raise RuntimeError("无法解析 QwenPaw 工作目录；请指定 --qwenpaw-working-dir") from exc
    value = result.stdout.strip()
    path = Path(value).expanduser() if result.returncode == 0 else Path()
    if not value or not path.is_absolute() or path.is_symlink():
        raise RuntimeError("无法解析 QwenPaw 工作目录；请指定 --qwenpaw-working-dir")
    return path.resolve()


def _validate_regular(path: Path, label: str, minimum: int = 1) -> None:
    try:
        is_regular = not path.is_symlink() and path.is_file()
        size_ok = is_regular and path.stat().st_size >= minimum
    except OSError as exc:
        raise RuntimeError(f"{label}不可用") from exc
    if not size_ok:
        raise RuntimeError(f"{label}不可用")
    if os.name == "nt":
        _validate_windows_acl(path, label)
    else:
        _validate_linux_material(path, label)


def _validate_channel_auth(path: Path) -> None:
    _validate_regular(path, "渠道授权文件")
    try:
        document = _read_json(path)
        credentials = document["credentials"]
        index = document["channelUserIndex"]
    except (KeyError, RuntimeError) as exc:
        raise RuntimeError("渠道授权文件格式无效") from exc
    if not isinstance(credentials, dict) or not isinstance(index, dict):
        raise RuntimeError("渠道授权文件格式无效")
    for channel, users in index.items():
        if channel not in {"wecom", "feishu"} or not isinstance(users, dict):
            raise RuntimeError("渠道授权文件格式无效")
        for user_id, credential_id in users.items():
            credential = credentials.get(credential_id) if isinstance(credential_id, str) else None
            blob = credential.get("ciphertext") if isinstance(credential, dict) else None
            if not isinstance(user_id, str) or not user_id or not isinstance(blob, str) or not blob.startswith("qdm1enc."):
                raise RuntimeError("渠道授权文件格式无效")


def _sensitive_material_paths(runtime: Path) -> tuple[Path, Path]:
    try:
        auth_file, secret_file = sensitive_material_paths(runtime)
        if os.name != "nt":
            expected_dir = Path("/run/secrets")
            if auth_file.parent != expected_dir or secret_file.parent != expected_dir:
                raise RuntimeError("QwenPaw Linux Secret 路径无效")
            return auth_file, secret_file
        expected_dir = (runtime / "config" / "qwenpaw").resolve(strict=True)
        if expected_dir != runtime / "config" / "qwenpaw":
            raise RuntimeError("QwenPaw 敏感配置目录不能是符号链接")
        for path in (auth_file, secret_file):
            path.relative_to(expected_dir)
    except (ConfigError, OSError, ValueError) as exc:
        raise RuntimeError("QwenPaw 敏感配置路径不可用") from exc
    return auth_file, secret_file


def _validate_windows_acl(path: Path, label: str) -> None:
    """Reject common broad read ACLs without ever reading file content."""
    if os.name != "nt": return
    try:
        result = subprocess.run(["icacls", str(path)], shell=False, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)
    except OSError as exc:
        raise RuntimeError(f"无法校验{label} ACL") from exc
    if result.returncode: raise RuntimeError(f"无法校验{label} ACL")
    broad = {
        "everyone",
        "builtin\\users",
        "nt authority\\authenticated users",
        "所有人",
        "builtin\\用户",
        "nt authority\\已验证用户",
    }
    for line in result.stdout.splitlines():
        identity, separator, permissions = line.strip().partition(":")
        if separator and identity.casefold() in broad and _has_read_permission(permissions):
            raise RuntimeError(
                f"{label} ACL 过宽：{path}。请执行：powershell -ExecutionPolicy Bypass -File "
                f'"{Path(__file__).with_name("prepare-qwenpaw-materials.ps1")}" -Runtime "{path.parents[2]}"'
            )


def _has_read_permission(value: str) -> bool:
    """Recognize icacls read-capable shorthand permissions on one ACE line."""
    permissions = value.upper()
    return any(marker in permissions for marker in ("(R)", "(RX)", "(M)", "(F)"))


def _validate_linux_material(path: Path, label: str) -> None:
    try:
        info = path.stat()
        parent_info = path.parent.stat()
    except OSError as exc:
        raise RuntimeError(f"{label}权限或状态不可用") from exc
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_gid != os.getegid():
        raise RuntimeError(f"{label}必须由当前 QwenPaw UID/GID 拥有")
    if info.st_mode & 0o077:
        raise RuntimeError(f"{label}权限必须不超过 0600")
    if parent_info.st_mode & 0o022:
        raise RuntimeError(f"{label}父目录不可被其他用户写入")
    if not _linux_mount_is_read_only(path.parent):
        raise RuntimeError(f"{label}必须来自只读挂载")


def _linux_mount_is_read_only(path: Path) -> bool:
    """Return whether the longest matching mount in Linux mountinfo is ro."""
    if os.name == "nt":
        return True
    try:
        target = str(path.resolve())
        best: tuple[int, bool] | None = None
        for line in Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines():
            fields = line.split(" - ", 1)
            left = fields[0].split()
            if len(left) < 6:
                continue
            mountpoint = left[4].replace("\\040", " ").replace("\\011", "\t")
            if target == mountpoint or target.startswith(mountpoint.rstrip("/") + "/"):
                options = left[5].split(",")
                super_options = fields[1].split()[2].split(",") if len(fields) > 1 and len(fields[1].split()) >= 3 else []
                candidate = (len(mountpoint), "ro" in options or "ro" in super_options)
                if best is None or candidate[0] > best[0]:
                    best = candidate
        return bool(best and best[1])
    except (OSError, ValueError):
        return False


def _runtime(value: str | None) -> Path:
    path = Path(value or "").expanduser()
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        raise RuntimeError("必须提供存在的绝对 --runtime")
    return path.resolve()


def _validate_runtime_binaries(runtime: Path) -> None:
    suffix = ".exe" if os.name == "nt" else ""
    for filename in (f"data-harness-cli{suffix}", f"qdm-metric-cli{suffix}"):
        path = runtime / "bin" / filename
        if path.is_symlink() or not path.is_file() or (os.name != "nt" and not path.stat().st_mode & stat.S_IXUSR):
            raise RuntimeError(f"缺少或拒绝非常规文件 {filename}")


def _agent_file(working_dir: str, agent_id: str, explicit: str) -> Path:
    path = (
        Path(explicit).expanduser()
        if explicit
        else Path(working_dir).expanduser() / "workspaces" / agent_id / "agent.json"
    )
    if not path.is_absolute():
        raise RuntimeError("agent 配置必须是绝对路径")
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("QDM Agent 的 agent.json 不存在或不是常规文件")
    return path


def _configure_allowlist(agent: Path, policy: str = "preserve") -> None:
    if policy not in TOOL_POLICIES:
        raise RuntimeError("tool_policy must be preserve or strict")
    data = _read_json(agent)
    light_context = data.setdefault("light_context_config", {})
    if not isinstance(light_context, dict):
        raise RuntimeError("agent.json light_context_config 閰嶇疆鏃犳晥")
    pruning = light_context.setdefault("tool_result_pruning_config", {})
    if not isinstance(pruning, dict):
        raise RuntimeError("agent.json tool_result_pruning_config 閰嶇疆鏃犳晥")
    # QDM query results must remain complete; operator may later re-enable this
    # host feature explicitly if the model/context policy requires it.
    pruning["enabled"] = False
    tools = data.setdefault("tools", {}).setdefault("builtin_tools", {})
    if not isinstance(tools, dict):
        raise RuntimeError("agent.json tools 配置无效")
    if policy == "strict":
        for name, value in tools.items():
            if isinstance(value, dict):
                value["enabled"] = name in ALLOWED_TOOLS
    for name, description in ALLOWED_TOOLS.items():
        existing = tools.get(name)
        if policy == "preserve" and isinstance(existing, dict):
            existing["enabled"] = True
            existing.setdefault("name", name)
            existing.setdefault("description", description)
            existing.setdefault("display_to_user", True)
            existing.setdefault("async_execution", False)
            existing.setdefault("icon", "📊" if name == "qdm_query" else "🔐")
            existing.setdefault("config", {})
            continue
        tools[name] = {
            "name": name,
            "enabled": True,
            "description": description,
            "display_to_user": True,
            "async_execution": False,
            "icon": "📊" if name == "qdm_query" else "🔐",
            "config": {},
        }
    _write_json(agent, data)


def _verify_allowlist(agent: Path, policy: str = "preserve") -> None:
    data = _read_json(agent)
    pruning = data.get("light_context_config", {}).get("tool_result_pruning_config", {})
    if not isinstance(pruning, dict) or pruning.get("enabled") is not False:
        raise RuntimeError("QDM Agent 必须关闭工具结果裁剪")
    tools = data.get("tools", {}).get("builtin_tools", {})
    enabled = (
        {
            name
            for name, value in tools.items()
            if isinstance(value, dict) and value.get("enabled") is True
        }
        if isinstance(tools, dict)
        else set()
    )
    if not set(ALLOWED_TOOLS).issubset(enabled):
        raise RuntimeError("QDM tools must be enabled")
    if policy == "strict" and enabled != set(ALLOWED_TOOLS):
        raise RuntimeError("仅允许 qdm_query、qdm_scope_summary、get_current_time")


def _verify_plugin_config(runtime: Path, agent_id: str) -> None:
    config = _read_json(DEFAULT_PLUGIN_CONFIG_FILE)
    required = {"schema_version", "runtime_dir", "qdm_agent_id", "user_id_display_mode"}
    allowed = required | {"context_limits", "query_limits", "report_limits", "tool_policy"}
    if not required.issubset(config) or not set(config).issubset(allowed):
        raise RuntimeError("插件配置包含不支持字段")
    if config.get("schema_version") != 1:
        raise RuntimeError("schema_version 无效")
    if config.get("runtime_dir") != str(runtime):
        raise RuntimeError("runtime_dir 与本次 --runtime 不一致")
    if config.get("qdm_agent_id") != agent_id:
        raise RuntimeError("qdm_agent_id 与本次 --agent-id 不一致")
    if config.get("user_id_display_mode") not in {"off", "command"}:
        raise RuntimeError("user_id_display_mode 无效")
    if config.get("tool_policy", "preserve") not in TOOL_POLICIES:
        raise RuntimeError("tool_policy invalid")
    try:
        parse_context_limits(config.get("context_limits"))
    except ConfigError as exc:
        raise RuntimeError("context_limits 无效") from exc
    try:
        parse_query_limits(config.get("query_limits"))
        parse_report_limits(config.get("report_limits"))
    except ConfigError as exc:
        raise RuntimeError("query_limits/report_limits 无效") from exc


def _configured_tool_policy() -> str:
    try:
        value = _read_json(DEFAULT_PLUGIN_CONFIG_FILE).get("tool_policy", "preserve")
    except RuntimeError:
        return "preserve"
    return value if value in TOOL_POLICIES else "preserve"


def _run_qwenpaw(python: str, working_dir: str, args: list[str]) -> None:
    result = subprocess.run(
        [python, "-m", "qwenpaw", *args],
        shell=False,
        env=_env(working_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode:
        raise RuntimeError("QwenPaw 插件命令失败")


def _env(working_dir: str) -> dict[str, str]:
    env = dict(os.environ)
    env["QWENPAW_WORKING_DIR"] = str(Path(working_dir).expanduser())
    return env


def _read_json(path: Path) -> dict[str, Any]:
    try:
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("JSON 配置不可用")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("JSON 配置不可用") from exc
    if not isinstance(value, dict):
        raise RuntimeError("JSON 配置必须为对象")
    return value


def _write_json(path: Path, value: dict[str, Any]) -> None:
    _write_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def _write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write(content)
        temp = Path(handle.name)
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


if __name__ == "__main__": raise SystemExit(main())
