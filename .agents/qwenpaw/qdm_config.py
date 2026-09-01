"""Static, operator-controlled configuration for the QwenPaw QDM plugin.

Schema 1 (legacy) derives every path from a single global ``runtime_dir``.
Schema 2 (reference model) holds plugin identity, a Root Context file
reference and a secret reference; the metric CLI path comes from the Root
Context (instanceRoot/config/settings.json), so the plugin stops trusting a
single global runtime directory.  A broken Root Context fails closed.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any


PROGRAM_DATA = Path("C:/ProgramData/QDM/qwenpaw") if os.name == "nt" else Path("/etc/qdm/qwenpaw")
DEFAULT_PLUGIN_CONFIG_FILE = PROGRAM_DATA / "plugin-config.json"
DEFAULT_QDM_AGENT_ID = "qdmDataAgent"
SENSITIVE_CONFIG_RELATIVE_DIR = Path("config") / "qwenpaw"
TOOL_POLICIES = frozenset({"preserve", "strict"})
LEGACY_SCHEMA = 1
REFERENCE_SCHEMA = 2


@dataclass(frozen=True)
class ContextLimits:
    """Optional, operator-controlled byte limits for Harness context."""

    base_context_bytes: int | None = None
    wiki_file_bytes: int | None = None
    wiki_total_bytes: int | None = None

@dataclass(frozen=True)
class QueryLimits:
    success_bytes: int | None = None
    timeout_seconds: int = 120

@dataclass(frozen=True)
class ReportLimits:
    additional_context_bytes: int | None = None


@dataclass(frozen=True)
class PluginConfig:
    qdm_agent_id: str
    user_id_display_mode: str
    tool_policy: str
    context_limits: ContextLimits
    query_limits: QueryLimits
    report_limits: ReportLimits
    auth_file_max_bytes: int | None = None
    context_cli_timeout_seconds: int = 60
    report_hook_timeout_seconds: int = 60
    # 引用模型字段 (schema 2): 插件身份 + Root Context + secret 引用
    plugin_id: str = "qdm-harness-qwenpaw"
    plugin_version: str = ""
    root_context_path: Path | None = None
    secret_ref: str | None = None
    enabled_agents: tuple[str, ...] = ()
    # 兼容模型字段 (schema 1): runtime_dir 派生
    runtime_dir: Path | None = None
    _metric_cli_path: str | None = None
    _sensitive_config_dir: str | None = None
    # schema 2: 从 Root Context 的 pluginRoot 解析的 harness CLI 路径
    _harness_cli_path: str | None = None

    @property
    def sensitive_config_dir(self) -> Path:
        if self._sensitive_config_dir:
            return Path(self._sensitive_config_dir)
        if self.runtime_dir is not None and os.name == "nt":
            return _confined_sensitive_dir(self.runtime_dir)
        return Path("/run/secrets")

    @property
    def auth_file(self) -> Path:
        return self.sensitive_config_dir / "channel-auth.json"

    @property
    def session_secret_file(self) -> Path:
        return self.sensitive_config_dir / "session-hmac.secret"

    @property
    def data_harness_cli(self) -> Path:
        if self._harness_cli_path:
            return Path(self._harness_cli_path)
        if self.runtime_dir is None:
            return Path("data-harness-cli")
        return self.runtime_dir / "bin" / ("data-harness-cli.exe" if os.name == "nt" else "data-harness-cli")

    @property
    def qdm_metric_cli(self) -> Path:
        if self._metric_cli_path:
            return Path(self._metric_cli_path)
        if self.runtime_dir is None:
            return Path("qdm-metric-cli")
        return self.runtime_dir / "bin" / ("qdm-metric-cli.exe" if os.name == "nt" else "qdm-metric-cli")


class ConfigError(ValueError):
    """An operator configuration is absent or violates the narrow contract."""


def load_config(path: Path = DEFAULT_PLUGIN_CONFIG_FILE) -> PluginConfig:
    """Load only non-secret, operator-written plugin settings."""
    raw = _read_json(path)
    schema = raw.get("schema_version")
    if schema == REFERENCE_SCHEMA:
        return _load_reference(raw, path)
    if schema == LEGACY_SCHEMA:
        return _load_legacy(raw)
    raise ConfigError("plugin config schema_version is invalid")


def _load_reference(raw: dict[str, Any], config_file: Path) -> PluginConfig:
    required = {"schema_version", "plugin_id", "qdm_agent_id", "user_id_display_mode"}
    allowed = required | {
        "plugin_version", "root_context_path", "secret_ref", "enabled_agents",
        "tool_policy", "context_limits", "query_limits", "report_limits",
        "auth_file_max_bytes", "context_cli_timeout_seconds", "report_hook_timeout_seconds",
    }
    if not required.issubset(raw) or not set(raw).issubset(allowed):
        raise ConfigError("plugin config contains unsupported fields")
    plugin_id = raw.get("plugin_id")
    agent_id = raw.get("qdm_agent_id")
    display = raw.get("user_id_display_mode")
    if not isinstance(plugin_id, str) or not plugin_id.strip():
        raise ConfigError("plugin_id is invalid")
    if not isinstance(agent_id, str) or not agent_id.strip():
        raise ConfigError("qdm_agent_id is invalid")
    if display not in {"off", "command"}:
        raise ConfigError("user_id_display_mode must be off or command")
    tool_policy = raw.get("tool_policy", "preserve")
    if tool_policy not in TOOL_POLICIES:
        raise ConfigError("tool_policy must be preserve or strict")

    context_path = _reference_path(raw.get("root_context_path"), "root_context_path", require_file=True)
    context = _load_root_context(context_path)
    metric_cli_path = _metric_cli_from_context(context, config_file)
    harness_cli_path = _harness_cli_from_context(context)
    sensitive_dir = _sensitive_dir_from_reference(raw.get("secret_ref"), context)

    enabled = raw.get("enabled_agents") or []
    if not isinstance(enabled, list) or not all(isinstance(item, str) and item.strip() for item in enabled):
        raise ConfigError("enabled_agents must be a list of agent ids")
    return PluginConfig(
        agent_id.strip(), display, tool_policy,
        parse_context_limits(raw.get("context_limits")),
        parse_query_limits(raw.get("query_limits")),
        parse_report_limits(raw.get("report_limits")),
        parse_auth_file_max_bytes(raw.get("auth_file_max_bytes")),
        parse_timeout(raw.get("context_cli_timeout_seconds"), "context_cli_timeout_seconds"),
        parse_timeout(raw.get("report_hook_timeout_seconds"), "report_hook_timeout_seconds"),
        plugin_id=plugin_id.strip(),
        plugin_version=str(raw.get("plugin_version") or "").strip(),
        root_context_path=context_path,
        secret_ref=str(raw.get("secret_ref") or "").strip() or None,
        enabled_agents=tuple(enabled),
        _metric_cli_path=str(metric_cli_path),
        _sensitive_config_dir=str(sensitive_dir),
        _harness_cli_path=str(harness_cli_path),
    )


def _load_legacy(raw: dict[str, Any]) -> PluginConfig:
    required = {"schema_version", "runtime_dir", "qdm_agent_id", "user_id_display_mode"}
    allowed = required | {"context_limits", "query_limits", "report_limits", "tool_policy", "auth_file_max_bytes", "context_cli_timeout_seconds", "report_hook_timeout_seconds"}
    if not required.issubset(raw) or not set(raw).issubset(allowed):
        raise ConfigError("plugin config contains unsupported fields")
    runtime = raw.get("runtime_dir")
    agent_id = raw.get("qdm_agent_id")
    display = raw.get("user_id_display_mode")
    if not isinstance(runtime, str) or not runtime.strip():
        raise ConfigError("runtime_dir is required")
    if not isinstance(agent_id, str) or not agent_id.strip():
        raise ConfigError("qdm_agent_id is invalid")
    if display not in {"off", "command"}:
        raise ConfigError("user_id_display_mode must be off or command")
    tool_policy = raw.get("tool_policy", "preserve")
    if tool_policy not in TOOL_POLICIES:
        raise ConfigError("tool_policy must be preserve or strict")
    runtime_path = Path(runtime).expanduser()
    if not runtime_path.is_absolute() or runtime_path.is_symlink() or not runtime_path.is_dir():
        raise ConfigError("runtime_dir must be absolute")
    return PluginConfig(agent_id.strip(), display, tool_policy, parse_context_limits(raw.get("context_limits")), parse_query_limits(raw.get("query_limits")), parse_report_limits(raw.get("report_limits")), parse_auth_file_max_bytes(raw.get("auth_file_max_bytes")), parse_timeout(raw.get("context_cli_timeout_seconds"), "context_cli_timeout_seconds"), parse_timeout(raw.get("report_hook_timeout_seconds"), "report_hook_timeout_seconds"), runtime_dir=runtime_path.resolve())


def parse_timeout(value: Any, field: str, default: int = 60, maximum: int = 300) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > maximum:
        raise ConfigError(f"{field} is invalid")
    return value

def parse_auth_file_max_bytes(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ConfigError("auth_file_max_bytes is invalid")
    return value


def parse_context_limits(value: Any) -> ContextLimits:
    """Validate optional limits; absent or null values intentionally mean unlimited."""
    if value is None:
        return ContextLimits()
    if not isinstance(value, dict) or set(value) != {
        "base_context_bytes", "wiki_file_bytes", "wiki_total_bytes",
    }:
        raise ConfigError("context_limits is invalid")
    limits: dict[str, int | None] = {}
    for name, limit in value.items():
        if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0):
            raise ConfigError(f"context_limits.{name} is invalid")
        limits[name] = limit
    return ContextLimits(**limits)

def _positive_or_none(value: Any, field: str) -> int | None:
    if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value <= 0):
        raise ConfigError(f"{field} is invalid")
    return value

def parse_query_limits(value: Any) -> QueryLimits:
    if value is None:
        return QueryLimits()
    if not isinstance(value, dict) or set(value) != {"success_bytes", "timeout_seconds"}:
        raise ConfigError("query_limits is invalid")
    timeout = value.get("timeout_seconds")
    if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
        raise ConfigError("query_limits.timeout_seconds is invalid")
    return QueryLimits(_positive_or_none(value.get("success_bytes"), "query_limits.success_bytes"), timeout)

def parse_report_limits(value: Any) -> ReportLimits:
    if value is None:
        return ReportLimits()
    if not isinstance(value, dict) or set(value) != {"additional_context_bytes"}:
        raise ConfigError("report_limits is invalid")
    return ReportLimits(_positive_or_none(value.get("additional_context_bytes"), "report_limits.additional_context_bytes"))


def _reference_path(value: Any, name: str, *, require_file: bool = False) -> Path | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{name} is invalid")
    path = Path(value).expanduser()
    if not path.is_absolute() or path.is_symlink():
        raise ConfigError(f"{name} must be an absolute, non-symlink path")
    if require_file and not path.is_file():
        raise ConfigError(f"{name} is unavailable")
    return path


def _load_root_context(path: Path) -> dict[str, Any]:
    if path is None:
        raise ConfigError("root_context_path is required")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError("root context is unavailable") from exc
    if not isinstance(value, dict):
        raise ConfigError("root context must be a JSON object")
    return value


def _metric_cli_from_context(context: dict[str, Any], config_file: Path) -> Path:
    config_path = context.get("configPath")
    if not isinstance(config_path, str) or not config_path:
        raise ConfigError("root context configPath is invalid")
    settings_file = Path(config_path).expanduser()
    if settings_file.is_symlink() or not settings_file.is_file():
        raise ConfigError("settings.json is unavailable")
    try:
        settings = json.loads(settings_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError("settings.json is unavailable") from exc
    metric = settings.get("metricCliPath") if isinstance(settings, dict) else None
    if not isinstance(metric, str) or not metric.strip() or not Path(metric).is_absolute():
        raise ConfigError("root context metricCliPath is invalid")
    return Path(metric)


def _harness_cli_from_context(context: dict[str, Any]) -> Path:
    plugin_root = context.get("pluginRoot") or context.get("artifactRoot")
    if not isinstance(plugin_root, str) or not plugin_root.strip():
        raise ConfigError("root context pluginRoot is invalid")
    base = Path(plugin_root).expanduser()
    if not base.is_absolute() or base.is_symlink() or not base.is_dir():
        raise ConfigError("root context pluginRoot must be an absolute, non-symlink directory")
    return base / "scripts" / ("data-harness-cli.exe" if os.name == "nt" else "data-harness-cli")


def _sensitive_dir_from_reference(secret_ref: Any, context: dict[str, Any]) -> Path:
    if isinstance(secret_ref, str) and secret_ref.strip():
        path = Path(secret_ref).expanduser()
        if not path.is_absolute() or path.is_symlink() or not path.is_dir():
            raise ConfigError("secret_ref must be an absolute, non-symlink directory")
        return path
    secret_root = context.get("secretRoot")
    if isinstance(secret_root, str) and secret_root:
        path = Path(secret_root).expanduser()
        if path.is_absolute() and not path.is_symlink():
            return path
    if os.name == "nt":
        raise ConfigError("secret_ref is required on Windows")
    return Path("/run/secrets")


def sensitive_material_paths(runtime_dir: Path) -> tuple[Path, Path]:
    """Derive the only accepted auth and HMAC locations from the runtime root."""
    if os.name != "nt":
        return Path("/run/secrets/channel-auth.json"), Path("/run/secrets/session-hmac.secret")
    directory = _confined_sensitive_dir(runtime_dir)
    return directory / "channel-auth.json", directory / "session-hmac.secret"


def _confined_sensitive_dir(runtime_dir: Path) -> Path:
    try:
        root = runtime_dir.resolve(strict=True)
    except OSError as exc:
        raise ConfigError("runtime_dir is unavailable") from exc
    directory = root / SENSITIVE_CONFIG_RELATIVE_DIR
    config_dir = root / "config"
    if config_dir.is_symlink() or directory.is_symlink():
        raise ConfigError("QwenPaw sensitive config path must not use symlinks")
    try:
        directory.relative_to(root)
    except ValueError as exc:  # defensive: the relative path is source-controlled
        raise ConfigError("QwenPaw sensitive config path escapes runtime") from exc
    return directory


def _read_json(path: Path) -> dict[str, Any]:
    try:
        if path.is_symlink() or not path.is_file():
            raise ConfigError("plugin config must be a regular file")
        if path.stat().st_size > 64 * 1024:
            raise ConfigError("plugin config is too large")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError("plugin config is unavailable") from exc
    if not isinstance(value, dict):
        raise ConfigError("plugin config must be a JSON object")
    return value
