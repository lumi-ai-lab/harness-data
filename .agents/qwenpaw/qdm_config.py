"""Static, operator-controlled configuration for the QwenPaw QDM plugin."""

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
    runtime_dir: Path
    qdm_agent_id: str
    user_id_display_mode: str
    tool_policy: str
    context_limits: ContextLimits
    query_limits: QueryLimits
    report_limits: ReportLimits
    auth_file_max_bytes: int | None = None
    context_cli_timeout_seconds: int = 60
    report_hook_timeout_seconds: int = 60
    @property
    def sensitive_config_dir(self) -> Path:
        return _confined_sensitive_dir(self.runtime_dir) if os.name == "nt" else Path("/run/secrets")

    @property
    def auth_file(self) -> Path:
        return self.sensitive_config_dir / "channel-auth.json"

    @property
    def session_secret_file(self) -> Path:
        return self.sensitive_config_dir / "session-hmac.secret"

    @property
    def data_harness_cli(self) -> Path:
        return self.runtime_dir / "bin" / ("data-harness-cli.exe" if os.name == "nt" else "data-harness-cli")

    @property
    def qdm_metric_cli(self) -> Path:
        return self.runtime_dir / "bin" / ("qdm-metric-cli.exe" if os.name == "nt" else "qdm-metric-cli")


class ConfigError(ValueError):
    """An operator configuration is absent or violates the narrow contract."""


def load_config(path: Path = DEFAULT_PLUGIN_CONFIG_FILE) -> PluginConfig:
    """Load only non-secret, operator-written plugin settings."""
    raw = _read_json(path)
    required = {"schema_version", "runtime_dir", "qdm_agent_id", "user_id_display_mode"}
    allowed = required | {"context_limits", "query_limits", "report_limits", "tool_policy", "auth_file_max_bytes", "context_cli_timeout_seconds", "report_hook_timeout_seconds"}
    if not required.issubset(raw) or not set(raw).issubset(allowed):
        raise ConfigError("plugin config contains unsupported fields")
    if raw.get("schema_version") != 1:
        raise ConfigError("plugin config schema_version is invalid")
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
    return PluginConfig(runtime_path.resolve(), agent_id.strip(), display, tool_policy, parse_context_limits(raw.get("context_limits")), parse_query_limits(raw.get("query_limits")), parse_report_limits(raw.get("report_limits")), parse_auth_file_max_bytes(raw.get("auth_file_max_bytes")), parse_timeout(raw.get("context_cli_timeout_seconds"), "context_cli_timeout_seconds"), parse_timeout(raw.get("report_hook_timeout_seconds"), "report_hook_timeout_seconds"))

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
