"""Entry point for the QDM Harness QwenPaw plugin."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
import logging
import hashlib
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from types import MethodType
from typing import Any

from agentscope.message import TextBlock, ToolResultState
from agentscope.tool import ToolChunk
from qwenpaw.plugins.api import PluginApi

from .qdm_channel_auth import ChannelAuthorizationError, ChannelAuthProvider
from .qdm_cli import QdmCliError, QdmCliExecutor, QueryScope
from .qdm_config import ConfigError, load_config
from .qdm_runtime_hooks import authorization_snapshot_context, hook_factories, requester_context


logger = logging.getLogger("qwenpaw.plugins.qdm_harness")


@dataclass(frozen=True)
class AuthorizationSnapshot:
    requester: Any
    blob: str
    scope: QueryScope
    credential_fingerprint: str
    scope_fingerprint: str


def _ensure_cli_executable(shim: Path | None = None) -> None:
    """Restore the exec bit on bundled CLI shims.

    QwenPaw's backend installs an uploaded ZIP with zipfile.extractall(),
    which drops Unix permission bits.  Without this the runtime bridges
    (authz-hook / context hook) and lifecycle commands fail to start.
    """
    if os.name == "nt":
        return
    shims = (
        (shim,)
        if shim is not None
        else tuple(
            Path(__file__).resolve().parent / "scripts" / name
            for name in ("data-harness-cli", "harness-data")
        )
    )
    for candidate in shims:
        try:
            mode = candidate.stat().st_mode
            if not mode & stat.S_IXUSR:
                candidate.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        except OSError as exc:
            logger.warning("could not make CLI shim executable (%s): %s", candidate, exc)


def _tool_descriptor_for(tool_name: str, tool_func: Any, enabled: bool, description: str) -> Any:
    """Return the host ToolDescriptor bound to *tool_func*, creating it lazily.

    register_tool defers descriptor attachment to a startup hook; the
    workspace re-injection below can run before that hook, so build the
    descriptor with the same fields the host would attach.
    """
    descriptor = getattr(tool_func, "_tool_descriptor", None)
    if descriptor is not None:
        return descriptor
    try:
        import inspect

        from qwenpaw.runtime.tool_registry import ToolDescriptor
    except ImportError:
        return None
    descriptor = ToolDescriptor(
        name=tool_name,
        func=tool_func,
        enabled_by_default=enabled,
        async_execution=inspect.iscoroutinefunction(tool_func),
        description=description,
    )
    tool_func._tool_descriptor = descriptor  # type: ignore[attr-defined]
    return descriptor


def _workspace_from_info(workspace_info: dict[str, Any]) -> Any | None:
    workspace = workspace_info.get("workspace")
    if workspace is None:
        try:
            from qwenpaw.plugins.registry import PluginRegistry

            manager = PluginRegistry().get_workspace_manager()
            workspace = (
                manager.agents.get(workspace_info.get("agent_id"))
                if manager is not None
                else None
            )
        except Exception:
            workspace = None
    return workspace


def _reinject_tools_into_workspace(workspace_info: dict[str, Any], tool_specs: tuple) -> None:
    """Re-inject the plugin tools into a (re)created workspace."""
    workspace = _workspace_from_info(workspace_info)
    if workspace is None:
        return
    tool_registry = getattr(getattr(workspace, "plugins", None), "tool_registry", None)
    if tool_registry is None:
        return
    for tool_name, tool_func, enabled, description, _icon in tool_specs:
        descriptor = _tool_descriptor_for(tool_name, tool_func, enabled, description)
        if descriptor is None:
            continue
        try:
            if tool_name in tool_registry and hasattr(tool_registry, "unregister"):
                tool_registry.unregister(tool_name)
            tool_registry.register(descriptor)
        except (TypeError, ValueError):
            pass


_LEGACY_RELOAD_BRIDGE_STATE = "_qdm_harness_reload_bridge_state"
_PLUGIN_ID = "qdm-harness-qwenpaw"


async def _run_legacy_workspace_callbacks(registry: Any, workspace_info: dict[str, Any]) -> None:
    """Run this plugin's in-memory workspace callbacks on QwenPaw 2.1."""
    import inspect

    runtime_prefix = f"rt_hook_ws_{_PLUGIN_ID}_"
    for registration in registry.get_workspace_created_hooks():
        if getattr(registration, "plugin_id", "") != _PLUGIN_ID:
            continue
        hook_name = str(getattr(registration, "hook_name", ""))
        if not (hook_name.startswith(runtime_prefix) or hook_name == "qdm_harness_reinject_tools"):
            continue
        callback = registration.callback
        result = callback(workspace_info)
        if inspect.isawaitable(result):
            await result


def _install_legacy_reload_bridge(
    *,
    registry: Any | None = None,
) -> bool:
    """Backport plugin-state reinjection for QwenPaw 2.1 zero-downtime reloads.

    QwenPaw 2.1 rebuilds a Workspace after channel/agent configuration changes
    but does not run workspace-created plugin hooks for that replacement.  The
    globally exported tool functions remain visible while the request identity
    hooks disappear, causing every real channel query to fail with
    QDM_CHANNEL_IDENTITY_UNAVAILABLE.  Newer hosts expose workspace setup hooks
    and do not need this compatibility bridge.
    """
    if registry is None:
        try:
            from qwenpaw.plugins.registry import PluginRegistry

            registry = PluginRegistry()
        except Exception:
            return False
    if callable(getattr(registry, "get_workspace_setup_hooks", None)):
        return False
    manager = getattr(registry, "get_workspace_manager", lambda: None)()
    if manager is None or not callable(getattr(manager, "reload_agent", None)):
        logger.warning("QwenPaw 2.1 reload bridge unavailable: workspace manager not ready")
        return False

    existing = getattr(manager, _LEGACY_RELOAD_BRIDGE_STATE, None)
    if isinstance(existing, dict):
        existing["registry"] = registry
        return True

    state = {
        "original": manager.reload_agent,
        "registry": registry,
    }
    setattr(manager, _LEGACY_RELOAD_BRIDGE_STATE, state)

    async def reload_agent_with_qdm(self: Any, agent_id: str) -> bool:
        current = getattr(self, _LEGACY_RELOAD_BRIDGE_STATE, state)
        result = await current["original"](agent_id)
        if not result:
            return result
        try:
            workspace = self.agents.get(agent_id)
            if workspace is None:
                return result
            workspace_info = {
                "agent_id": agent_id,
                "workspace_dir": str(getattr(workspace, "workspace_dir", "")),
                "workspace": workspace,
            }
            await _run_legacy_workspace_callbacks(current["registry"], workspace_info)
            logger.info("QDM Harness plugin state restored after QwenPaw 2.1 workspace reload")
        except Exception:
            logger.exception("QDM Harness failed to restore plugin state after workspace reload")
        return result

    manager.reload_agent = MethodType(reload_agent_with_qdm, manager)
    logger.info("Installed QwenPaw 2.1 workspace reload compatibility bridge")
    return True


class QdmHarnessQwenPawPlugin:
    def register(self, api: PluginApi) -> None:
        _require_qwenpaw_21()
        _ensure_cli_executable()
        # QwenPaw's native Plugin API registers HookBase instances into every
        # workspace's HookRegistry on startup (register_runtime_hook).
        register_hook = getattr(api, "register_runtime_hook", None)
        if not callable(register_hook):
            raise RuntimeError("QDM Harness requires QwenPaw with register_runtime_hook()")
        runtime_hook_specs = hook_factories()
        for _hook_name, factory, _priority in runtime_hook_specs:
            register_hook(factory())

        async def qdm_query(
            metric: str,
            start_date: str,
            end_date: str,
            statistic_policy: str = "SUMMARY",
            agg_dims: list[str] | None = None,
            filters: dict[str, list[str]] | None = None,
            time_grain: str | None = None,
            order_by: str | None = None,
            page_size: int | None = None,
            curr_page: int | None = None,
            yoy: bool = False,
            mom: bool = False,
        ) -> ToolChunk:
            """Query one handbook-defined QDM metric with structured parameters only."""
            return _query(
                metric=metric,
                start_date=start_date,
                end_date=end_date,
                statistic_policy=statistic_policy,
                agg_dims=agg_dims,
                filters=filters,
                time_grain=time_grain,
                order_by=order_by,
                page_size=page_size,
                curr_page=curr_page,
                yoy=yoy,
                mom=mom,
            )

        async def qdm_scope_summary() -> ToolChunk:
            return _scope_summary()

        tool_specs = (
            ("qdm_query", qdm_query, True, "执行受限的 QDM 指标查询。必须使用已注入的 QDM 手册中的指标代码和参数契约；filters 是维度代码到值 ID 列表的映射。权限拒绝或参数/上游错误后不得使用完全相同参数重试；成功但无数据须与权限拒绝区分。", "📊"),
            ("qdm_scope_summary", qdm_scope_summary, True, "返回当前渠道用户的脱敏 QDM 数据权限摘要。后续查询必须原样使用摘要中的维度代码（例如 authz-v2 的 sapArea2Id），不得擅自替换为旧维度名。", "🔐"),
        )
        for tool_name, tool_func, enabled, description, icon in tool_specs:
            api.register_tool(tool_name=tool_name, tool_func=tool_func, description=description, icon=icon, enabled=enabled, tool_type="internal")
        register_ws_hook = getattr(api, "register_workspace_created_hook", None)
        if callable(register_ws_hook):
            try:
                register_ws_hook(
                    hook_name="qdm_harness_reinject_tools",
                    callback=lambda workspace_info: _reinject_tools_into_workspace(workspace_info, tool_specs),
                    priority=90,
                    reload_safe=True,
                )
            except TypeError:
                # QwenPaw 2.1.x 的 workspace_created 钩子没有 reload_safe 参数。
                register_ws_hook(
                    hook_name="qdm_harness_reinject_tools",
                    callback=lambda workspace_info: _reinject_tools_into_workspace(workspace_info, tool_specs),
                    priority=90,
                )
        else:
            logger.warning("QwenPaw host lacks register_workspace_created_hook(); qdm tools may disappear after plugin hot-reload")
        register_startup_hook = getattr(api, "register_startup_hook", None)
        if callable(register_startup_hook):
            register_startup_hook(
                hook_name="qdm_harness_install_reload_bridge",
                callback=_install_legacy_reload_bridge,
                priority=95,
            )
        else:
            _install_legacy_reload_bridge()
        logger.info("QDM Harness runtime hooks and constrained tools registered")


_SUPPORTED_QWENPAW_MAJOR_MINOR = frozenset({(2, 1), (2, 2)})


def _supported_qwenpaw_version(installed: str) -> bool:
    """Semantic version gate: accept 2.1.x and 2.2.x, including pre-releases.

    QwenPaw pre-release builds are treated as their base release (e.g.
    2.2.0b3 -> 2.2.0), mirroring the host's own compatibility check.
    """
    base = installed.split("+", 1)[0].strip().lower()
    for marker in ("rc", "b", "a", "dev"):
        if marker in base:
            base = base.split(marker, 1)[0]
    parts = base.split(".")
    try:
        major = int(parts[0])
        minor = int(parts[1]) if len(parts) > 1 else 0
    except (ValueError, IndexError):
        return False
    return (major, minor) in _SUPPORTED_QWENPAW_MAJOR_MINOR


def _require_qwenpaw_21() -> None:
    try:
        installed = version("qwenpaw")
    except PackageNotFoundError as exc:
        raise RuntimeError("QDM Harness requires QwenPaw 2.1.x or 2.2.x") from exc
    if not _supported_qwenpaw_version(installed):
        raise RuntimeError(f"QDM Harness requires QwenPaw 2.1.x or 2.2.x (found {installed})")


def _trusted_components() -> tuple[ChannelAuthProvider, QdmCliExecutor, Any]:
    requester = requester_context.get()
    if requester is None or requester.status != "resolved":
        raise QdmCliError(
            "QDM_CHANNEL_IDENTITY_UNAVAILABLE",
            "当前会话不支持 QDM 数据查询。请通过已配置的企微或飞书机器人发起请求。",
        )
    existing = authorization_snapshot_context.get()
    if isinstance(existing, AuthorizationSnapshot):
        if existing.requester != requester:
            raise QdmCliError("QDM_CHANNEL_IDENTITY_MISMATCH", "当前请求身份与授权上下文不一致")
        return None, None, existing  # type: ignore[return-value]
    try:
        config = load_config()
    except ConfigError as exc:
        raise QdmCliError("QDM_CHANNEL_AUTH_DENIED", "QDM 渠道授权不可用或被拒绝") from exc
    provider = ChannelAuthProvider(config.auth_file, max_bytes=config.auth_file_max_bytes)
    executor = QdmCliExecutor(
        config.qdm_metric_cli,
        harness_cli=Path(__file__).resolve().parent / "scripts" / "data-harness-cli",
        context_file=config.root_context_path,
        success_bytes=config.query_limits.success_bytes,
        timeout_seconds=config.query_limits.timeout_seconds,
    )
    blob = provider.blob_for(requester)
    scope = executor.preflight_query(blob)
    snapshot = AuthorizationSnapshot(requester, blob, scope,
                                     hashlib.sha256(blob.encode()).hexdigest()[:16],
                                     hashlib.sha256(repr(scope.data_scope).encode()).hexdigest()[:16])
    authorization_snapshot_context.set(snapshot)
    return provider, executor, config


def _query(**query: Any) -> ToolChunk:
    try:
        provider, executor, _config = _trusted_components()
        requester = requester_context.get()
        assert requester is not None
        snapshot = authorization_snapshot_context.get()
        if isinstance(snapshot, AuthorizationSnapshot):
            result = executor.query(blob=snapshot.blob, scope=snapshot.scope, **query)
        else:
            result = executor.query(blob=provider.blob_for(requester), **query)
        return _success(result)
    except (ChannelAuthorizationError, QdmCliError) as exc:
        error = _channel_auth_error(exc)
        logger.warning("qdm_query_failed code=%s", error.code)
        return _failure(error)


def _scope_summary() -> ToolChunk:
    try:
        provider, executor, _config = _trusted_components()
        requester = requester_context.get()
        assert requester is not None
        snapshot = authorization_snapshot_context.get()
        if isinstance(snapshot, AuthorizationSnapshot):
            return _success({"enabled": True, "capabilities": sorted(snapshot.scope.capabilities),
                             "dataScope": {k: [{"id": e.id, "name": e.name} for e in v] for k, v in snapshot.scope.data_scope.items()},
                             "scopeFingerprint": snapshot.scope_fingerprint,
                             "credentialFingerprint": snapshot.credential_fingerprint})
        return _success(executor.scope_summary(provider.blob_for(requester)))
    except (ChannelAuthorizationError, QdmCliError) as exc:
        error = _channel_auth_error(exc)
        logger.warning("qdm_scope_summary_failed code=%s", error.code)
        return _failure(error)


def _channel_auth_error(exc: ChannelAuthorizationError | QdmCliError) -> QdmCliError:
    if isinstance(exc, QdmCliError):
        return exc
    return QdmCliError("QDM_CHANNEL_AUTH_DENIED", "QDM 渠道授权不可用或被拒绝")


def _success(value: str | dict[str, Any]) -> ToolChunk:
    text = value if isinstance(value, str) else json_dumps(value)
    return ToolChunk(is_last=True, state=ToolResultState.SUCCESS, content=[TextBlock(type="text", text=text)])


def _failure(error: QdmCliError) -> ToolChunk:
    return ToolChunk(is_last=True, state=ToolResultState.ERROR, content=[TextBlock(type="text", text=f"{error.code}: {error.message}")])


def json_dumps(value: dict[str, Any]) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


plugin = QdmHarnessQwenPawPlugin()
