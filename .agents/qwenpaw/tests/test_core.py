from __future__ import annotations

import json
import importlib.util
import importlib
import asyncio
import inspect
import os
import stat
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "qdm_harness_qwenpaw_test"
if PACKAGE not in sys.modules:
    package = types.ModuleType(PACKAGE)
    package.__path__ = [str(ROOT)]
    sys.modules[PACKAGE] = package

from qdm_harness_qwenpaw_test.qdm_channel_auth import ChannelAuthorizationError, ChannelAuthProvider
from qdm_harness_qwenpaw_test.qdm_cli import QdmCliError, QdmCliExecutor, _query_args, _truncate_success
from qdm_harness_qwenpaw_test.qdm_debug_identity import DEBUG_COMMAND, debug_result, record_reload_bridge_state
from qdm_harness_qwenpaw_test.qdm_harness_context import HarnessContextError, _context_cli_failure_reason, _sanitize_embedded_context_instruction, request_context, session_key
from qdm_harness_qwenpaw_test.qdm_identity import Requester, resolve_requester
from qdm_harness_qwenpaw_test.qdm_config import AgentScope, ConfigError, ContextLimits, QueryLimits, ReportLimits, load_config, parse_agent_scope, DEFAULT_AGENT_SCOPE_PATTERNS
from qdm_harness_qwenpaw_test.qdm_report_lifecycle import LifecycleResult, complete_qdm_query
from qdm_harness_qwenpaw_test.plugin import QdmHarnessQwenPawPlugin
from qdm_harness_qwenpaw_test.qdm_runtime_hooks import QdmRequesterContextHook, QdmRequesterIdentityHook, QwenPawHarnessContextHook, UNAUTHORIZED_SESSION_CONSTRAINT, hook_factories, requester_context
from qwenpaw.runtime.hooks import HookAction, HookBase, HookRegistry
from qwenpaw.runtime.phases import Phase
from qwenpaw.runtime.tool_registry import ToolDescriptor, ToolRegistry
from agentscope.message import ToolResultState


PLUGIN_MODULE = importlib.import_module(f"{PACKAGE}.plugin")
RUNTIME_HOOKS_MODULE = importlib.import_module(f"{PACKAGE}.qdm_runtime_hooks")


def _load_installer() -> types.ModuleType:
    sys.path.insert(0, str(ROOT))
    try:
        spec = importlib.util.spec_from_file_location(
            "qdm_harness_installer_test", ROOT / "install-qwenpaw-plugin.py",
        )
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(ROOT))


INSTALLER = _load_installer()


def _write_placeholder_cli(path: Path) -> None:
    """Write a placeholder CLI file and make it executable on POSIX hosts."""
    path.write_bytes(b"placeholder")
    if os.name != "nt":
        path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _make_sensitive(path: Path) -> None:
    """Apply the 0600 permission expected for sensitive materials on POSIX."""
    if os.name != "nt":
        path.chmod(0o600)


SCOPE_CN01 = {"enabled": True, "capabilities": ["qdm.metric.query"], "labelsResolved": True, "dataScope": {"manageAreaId": [{"id": "CN01", "name": "区域"}]}}
SCOPE_AREA001 = {"enabled": True, "capabilities": ["qdm.metric.query"], "labelsResolved": True, "dataScope": {"manageAreaId": [{"id": "AREA_001", "name": "粤东区"}]}}
SCOPE_STORE = {"enabled": True, "capabilities": ["qdm.metric.query"], "labelsResolved": True, "dataScope": {"manageAreaId": [{"id": "AREA_001", "name": "华南"}], "storeId": [{"id": "S001", "name": "广州时代玫瑰"}]}}


def _cli_pair(temp: str) -> tuple[Path, Path]:
    cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
    harness = Path(temp) / "bin" / "data-harness-cli.exe"
    cli.parent.mkdir(parents=True)
    _write_placeholder_cli(cli)
    _write_placeholder_cli(harness)
    return cli, harness


def _allow_envelope(scope: object, normalized_filters: object | None = None) -> dict[str, object]:
    hook: dict[str, object] = {"permissionDecision": "allow", "scope": scope}
    if normalized_filters is not None:
        hook["normalizedFilters"] = normalized_filters
    return {"schemaVersion": 1, "status": "allow", "hookOutput": hook}


def _deny_envelope(reason: str) -> dict[str, object]:
    return {"schemaVersion": 1, "status": "deny", "hookOutput": {"permissionDecision": "deny", "permissionDecisionReason": reason}}


def _routed_run(envelope: object, *, execute_out: str = "{}", execute_err: str = "", execute_rc: int = 0):
    """Route subprocess invocations: authz-hook answers the envelope, others execute."""
    def fake_run(argv: object, **kwargs: object) -> types.SimpleNamespace:
        args = list(argv or [])
        if "authz-hook" in args:
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(envelope), stderr="")
        return types.SimpleNamespace(returncode=execute_rc, stdout=execute_out, stderr=execute_err)
    return fake_run


class _Message:
    def __init__(self, text: str) -> None:
        self.text = text

    def get_text_content(self) -> str:
        return self.text


class _Context:
    def __init__(self, text: str) -> None:
        self.input_msgs = [_Message(text)]


class _Request:
    def __init__(self, channel: str, channel_meta: dict[str, object]) -> None:
        self.channel = channel
        self.channel_meta = channel_meta
        self.request_context: dict[str, object] = {}


class _AgentContext(_Context):
    def __init__(self, channel: str, channel_meta: dict[str, object], text: str = "你好", agent_id: str = "qdmDataAgent") -> None:
        super().__init__(text)
        self.agent_id = agent_id
        self.request = _Request(channel, channel_meta)
        self.extras: dict[str, object] = {}
        self.injected: list[tuple[str, int, str]] = []

    def inject_context(self, content: str, *, priority: int, source: str) -> None:
        self.injected.append((content, priority, source))


def _scoped_config(patterns: tuple[str, ...], **extra: object) -> types.SimpleNamespace:
    """A plugin config stub whose only job is the agent activation scope."""
    return types.SimpleNamespace(agent_scope=AgentScope(patterns), qdm_agent_id=patterns[0] if patterns else "", **extra)


def _component_config() -> types.SimpleNamespace:
    """A plugin config stub complete enough for ``_build_components``."""
    return _scoped_config(
        ("default",),
        auth_file=Path("/tmp/qdm-channel-auth.json"),
        auth_file_max_bytes=None,
        qdm_metric_cli=Path("/tmp/qdm-metric-cli"),
        root_context_path=Path("/tmp/context.json"),
        query_limits=QueryLimits(),
    )


class _QdmRecorder:
    """Stand in for the auth provider and executor, counting subprocess entry points."""

    def __init__(self) -> None:
        self.preflights = 0
        self.queries = 0

    @staticmethod
    def blob_for(_requester: object) -> str:
        return "qdm1enc.blob"

    @staticmethod
    def scope() -> types.SimpleNamespace:
        return types.SimpleNamespace(capabilities=(), data_scope={})

    def preflight_query(self, _blob: str) -> types.SimpleNamespace:
        self.preflights += 1
        return self.scope()

    def query(self, **_kwargs: object) -> str:
        self.queries += 1
        return "1 行"


class IdentityTests(unittest.TestCase):
    def test_single_chat_resolves_channel_and_user_only(self) -> None:
        actual = resolve_requester("wecom", {"wecom_sender_id": "zhangsan", "wecom_chatid": "chat-1"})
        self.assertEqual(actual, Requester(1, "resolved", "wecom", "zhangsan", "single", "chat-1"))
        self.assertEqual(actual.chat_id, "chat-1")

    def test_feishu_group_requires_trusted_mention_marker(self) -> None:
        denied = resolve_requester("feishu", {"is_group": True, "feishu_sender_id": "ou_123"})
        self.assertEqual(denied.status, "unavailable")
        accepted = resolve_requester("feishu", {"is_group": True, "bot_mentioned": True, "feishu_sender_id": "ou_123"})
        self.assertEqual(accepted.status, "resolved")
        self.assertEqual(accepted.chat_type, "group")

    def test_wecom_group_trusts_host_routing_and_still_requires_sender_id(self) -> None:
        actual = resolve_requester("wecom", {"is_group": True, "wecom_sender_id": "zhangsan", "wecom_chatid": "group-1"})
        self.assertEqual(actual.status, "resolved")
        missing = resolve_requester("wecom", {"is_group": True, "wecom_chatid": "group-1"})
        self.assertEqual(missing.status, "unavailable")

    def test_feishu_shared_markers_fail_closed(self) -> None:
        for sender in ("group", "thread:abc", ""):
            actual = resolve_requester("feishu", {"is_group": True, "bot_mentioned": True, "feishu_sender_id": sender})
            self.assertEqual(actual.status, "unavailable")


class AuthorizationTests(unittest.TestCase):
    def test_exact_channel_user_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "channel-auth.json"
            file.write_text(json.dumps({"credentials": {"cred_1": {"ciphertext": "qdm1enc.safe"}}, "channelUserIndex": {"wecom": {"zhangsan": "cred_1"}}}), encoding="utf-8")
            provider = ChannelAuthProvider(file)
            self.assertEqual(provider.blob_for(Requester(1, "resolved", "wecom", "zhangsan", "single")), "qdm1enc.safe")
            with self.assertRaises(ChannelAuthorizationError):
                provider.blob_for(Requester(1, "resolved", "feishu", "zhangsan", "single"))

    def test_hmac_key_is_stable_and_does_not_include_raw_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            secret = Path(temp) / "secret"
            secret.write_bytes(b"x" * 32)
            one = session_key(secret, "wecom", "wecom:zhangsan")
            two = session_key(secret, "feishu", "wecom:zhangsan")
            self.assertTrue(one.startswith("qwenpaw:"))
            self.assertNotIn("zhangsan", one)
            self.assertNotEqual(one, two)

    def test_reference_config_derives_paths_from_root_context(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            instance = root / "instance"
            config_dir = instance / "config"
            config_dir.mkdir(parents=True)
            runtimes = instance / "runtimes" / "darwin-arm64"
            runtimes.mkdir(parents=True)
            metric = runtimes / "qdm-metric-cli"
            metric.write_bytes(b"x")
            secret_dir = root / "secrets"
            secret_dir.mkdir()
            plugin_root = root / "plugin"
            plugin_root.mkdir()
            config_dir.joinpath("settings.json").write_text(json.dumps({"schemaVersion": 1, "metricCliPath": str(metric)}), encoding="utf-8")
            context_file = instance / "context.json"
            context_file.write_text(json.dumps({
                "schemaVersion": 1, "host": "qwenpaw",
                "pluginRoot": str(plugin_root),
                "resourceRoot": str(instance), "dataRoot": str(root / "data"),
                "secretRoot": str(secret_dir), "configPath": str(config_dir / "settings.json"),
            }), encoding="utf-8")
            config = root / "plugin-config.json"
            config.write_text(json.dumps({
                "schema_version": 2,
                "plugin_id": "qdm-harness-qwenpaw",
                "plugin_version": "0.1.6",
                "root_context_path": str(context_file),
                "secret_ref": str(secret_dir),
                "enabled_agents": ["qdmDataAgent"],
                "qdm_agent_id": "qdmDataAgent",
                "user_id_display_mode": "off",
            }), encoding="utf-8")
            loaded = load_config(config)
            self.assertEqual(loaded.plugin_id, "qdm-harness-qwenpaw")
            self.assertEqual(loaded.plugin_version, "0.1.6")
            self.assertEqual(loaded.root_context_path, context_file)
            self.assertEqual(loaded.enabled_agents, ("qdmDataAgent",))
            self.assertEqual(loaded.qdm_metric_cli, metric)
            self.assertEqual(loaded.auth_file, secret_dir / "channel-auth.json")
            self.assertEqual(loaded.session_secret_file, secret_dir / "session-hmac.secret")

    def test_reference_config_fails_closed_on_broken_context(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "plugin-config.json"
            base = {
                "schema_version": 2,
                "plugin_id": "qdm-harness-qwenpaw",
                "root_context_path": str(root / "missing" / "context.json"),
                "qdm_agent_id": "qdmDataAgent",
                "user_id_display_mode": "off",
            }
            config.write_text(json.dumps(base), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config(config)
            config.write_text(json.dumps({k: v for k, v in base.items() if k != "root_context_path"}), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config(config)

    def test_reference_config_rejects_unsupported_fields_and_missing_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "plugin-config.json"
            config.write_text(json.dumps({"schema_version": 2, "qdm_agent_id": "qdmDataAgent", "user_id_display_mode": "off", "runtime_dir": str(root)}), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config(config)

    @unittest.skipUnless(os.name == "nt", "Windows 敏感材料目录布局(非 Windows 使用 /run/secrets)")
    def test_runtime_config_derives_and_confines_sensitive_material_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp) / "runtime"
            runtime.mkdir()
            config = Path(temp) / "plugin-config.json"
            config.write_text(json.dumps({"schema_version": 1, "runtime_dir": str(runtime), "qdm_agent_id": "qdmDataAgent", "user_id_display_mode": "off"}), encoding="utf-8")
            loaded = load_config(config)
            self.assertEqual(loaded.auth_file, runtime / "config" / "qwenpaw" / "channel-auth.json")
            self.assertEqual(loaded.session_secret_file, runtime / "config" / "qwenpaw" / "session-hmac.secret")
            self.assertEqual(loaded.context_limits, ContextLimits())
            self.assertEqual(loaded.query_limits, QueryLimits())
            self.assertEqual(loaded.report_limits, ReportLimits())
            self.assertIsNone(loaded.auth_file_max_bytes)

    def test_auth_file_max_bytes_is_optional_and_strict(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp) / "runtime"; runtime.mkdir()
            config = Path(temp) / "plugin-config.json"
            base = {"schema_version": 1, "runtime_dir": str(runtime), "qdm_agent_id": "qdmDataAgent", "user_id_display_mode": "off"}
            config.write_text(json.dumps(base | {"auth_file_max_bytes": 8388608}), encoding="utf-8")
            self.assertEqual(load_config(config).auth_file_max_bytes, 8388608)
            for value in (0, -1, True, "8388608"):
                config.write_text(json.dumps(base | {"auth_file_max_bytes": value}), encoding="utf-8")
                with self.assertRaises(ConfigError):
                    load_config(config)

    def test_query_and_report_limits_are_strict_and_optional(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp) / "runtime"
            runtime.mkdir()
            config = Path(temp) / "plugin-config.json"
            base = {"schema_version": 1, "runtime_dir": str(runtime), "qdm_agent_id": "qdmDataAgent", "user_id_display_mode": "off"}
            value = base | {"query_limits": {"success_bytes": 100, "timeout_seconds": 30}, "report_limits": {"additional_context_bytes": 200}}
            config.write_text(json.dumps(value), encoding="utf-8")
            loaded = load_config(config)
            self.assertEqual(loaded.query_limits, QueryLimits(100, 30))
            self.assertEqual(loaded.report_limits, ReportLimits(200))
            for invalid in (
                {"success_bytes": 0, "timeout_seconds": 30},
                {"success_bytes": None, "timeout_seconds": 0},
                {"success_bytes": 100, "timeout_seconds": True, "extra": 1},
            ):
                config.write_text(json.dumps(base | {"query_limits": invalid}), encoding="utf-8")
                with self.assertRaises(ConfigError):
                    load_config(config)

    def test_context_limits_are_optional_but_strict_when_present(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp) / "runtime"
            runtime.mkdir()
            config = Path(temp) / "plugin-config.json"
            base = {"schema_version": 1, "runtime_dir": str(runtime), "qdm_agent_id": "qdmDataAgent", "user_id_display_mode": "off"}
            config.write_text(json.dumps(base | {"context_limits": {"base_context_bytes": None, "wiki_file_bytes": 100, "wiki_total_bytes": 200}}), encoding="utf-8")
            self.assertEqual(load_config(config).context_limits, ContextLimits(None, 100, 200))
            for limits in (
                {"base_context_bytes": 0, "wiki_file_bytes": None, "wiki_total_bytes": None},
                {"base_context_bytes": -1, "wiki_file_bytes": None, "wiki_total_bytes": None},
                {"base_context_bytes": True, "wiki_file_bytes": None, "wiki_total_bytes": None},
                {"base_context_bytes": 1.5, "wiki_file_bytes": None, "wiki_total_bytes": None},
                {"base_context_bytes": "100", "wiki_file_bytes": None, "wiki_total_bytes": None},
                {"base_context_bytes": None, "wiki_file_bytes": None, "wiki_total_bytes": None, "extra": 1},
            ):
                config.write_text(json.dumps(base | {"context_limits": limits}), encoding="utf-8")
                with self.assertRaises(ConfigError):
                    load_config(config)

    def test_runtime_config_rejects_a_symlinked_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = root / "runtime"
            runtime.mkdir()
            link = root / "runtime-link"
            try:
                link.symlink_to(runtime, target_is_directory=True)
            except OSError:
                self.skipTest("symlink creation unavailable")
            config = root / "plugin-config.json"
            config.write_text(json.dumps({"schema_version": 1, "runtime_dir": str(link), "qdm_agent_id": "qdmDataAgent", "user_id_display_mode": "off"}), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config(config)


class AgentScopeTests(unittest.TestCase):
    """The activation scope decides which agents get hooks *and* get the tools."""

    def test_default_scope_is_the_prefix_convention_alone(self) -> None:
        scope = AgentScope()
        self.assertEqual(scope.patterns, DEFAULT_AGENT_SCOPE_PATTERNS)
        self.assertTrue(scope.allows("harness-data-east"))
        self.assertFalse(scope.allows("default"), "the host's shared default agent must be opted in explicitly")
        self.assertFalse(scope.allows("qdmDataAgent"))
        self.assertFalse(scope.allows(""))
        self.assertFalse(scope.allows(None))

    def test_matching_stays_case_sensitive_on_every_platform(self) -> None:
        self.assertFalse(AgentScope(("harness-data-*",)).allows("HARNESS-DATA-EAST"))

    def test_named_entry_differs_from_a_wildcard_sweep(self) -> None:
        wildcard = AgentScope(("*",))
        self.assertTrue(wildcard.allows("default"))
        self.assertFalse(wildcard.allows_by_exact_name("default"))
        named = AgentScope(("default", "harness-data-*"))
        self.assertTrue(named.allows_by_exact_name("default"))

    def test_absent_enabled_agents_falls_back_to_legacy_id_or_default(self) -> None:
        self.assertEqual(parse_agent_scope(None, "qdmDataAgent").patterns, ("qdmDataAgent",))
        self.assertEqual(parse_agent_scope(None).patterns, DEFAULT_AGENT_SCOPE_PATTERNS)

    def test_legacy_id_merges_into_an_explicit_scope(self) -> None:
        scope = parse_agent_scope(["harness-data-*"], "qdmDataAgent")
        self.assertEqual(scope.patterns, ("harness-data-*", "qdmDataAgent"))
        self.assertTrue(scope.allows("qdmDataAgent"))
        self.assertTrue(scope.allows("harness-data-north"))
        self.assertEqual(parse_agent_scope(["qdmDataAgent"], "qdmDataAgent").patterns, ("qdmDataAgent",))

    def test_explicit_empty_scope_is_a_kill_switch(self) -> None:
        scope = parse_agent_scope([])
        self.assertEqual(scope.patterns, ())
        self.assertFalse(scope.allows("harness-data-east"))

    def test_invalid_patterns_fail_closed(self) -> None:
        for bad in (["has space"], ["a/b"], ["a\\b"], ["-lead"], ["[abc]*"], [""], ["x" * 65], ["harness-data-*", "harness-data-*", "has space"]):
            with self.assertRaises(ConfigError, msg=str(bad)):
                parse_agent_scope(bad)
        for bad_shape in ("harness-data-*", 1, [1], {"a": 1}, [None]):
            with self.assertRaises(ConfigError, msg=str(bad_shape)):
                parse_agent_scope(bad_shape)
        with self.assertRaises(ConfigError):
            parse_agent_scope([f"harness-data-{index}" for index in range(33)])

    def test_legacy_runtime_config_accepts_enabled_agents(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp) / "runtime"
            runtime.mkdir()
            config = Path(temp) / "plugin-config.json"
            config.write_text(json.dumps({
                "schema_version": 1, "runtime_dir": str(runtime),
                "qdm_agent_id": "qdmDataAgent", "user_id_display_mode": "off",
                "enabled_agents": ["harness-data-*"],
            }), encoding="utf-8")
            loaded = load_config(config)
            self.assertEqual(loaded.enabled_agents, ("harness-data-*", "qdmDataAgent"))
            self.assertTrue(loaded.agent_scope.allows("harness-data-east"))
            self.assertTrue(loaded.agent_scope.allows("qdmDataAgent"))

    def test_reference_config_without_legacy_agent_id_loads(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "instance" / "config").mkdir(parents=True)
            (root / "secrets").mkdir()
            (root / "plugin").mkdir()
            metric = root / "metric"
            metric.write_bytes(b"x")
            settings = root / "instance" / "config" / "settings.json"
            settings.write_text(json.dumps({"schemaVersion": 1, "metricCliPath": str(metric)}), encoding="utf-8")
            context_file = root / "instance" / "context.json"
            context_file.write_text(json.dumps({
                "schemaVersion": 1, "host": "qwenpaw", "pluginRoot": str(root / "plugin"),
                "resourceRoot": str(root / "instance"), "dataRoot": str(root / "data"),
                "secretRoot": str(root / "secrets"), "configPath": str(settings),
            }), encoding="utf-8")
            config = root / "plugin-config.json"
            config.write_text(json.dumps({
                "schema_version": 2, "plugin_id": "qdm-harness-qwenpaw",
                "root_context_path": str(context_file), "secret_ref": str(root / "secrets"),
                "user_id_display_mode": "off",
            }), encoding="utf-8")
            loaded = load_config(config)
            self.assertEqual(loaded.qdm_agent_id, "")
            self.assertEqual(loaded.enabled_agents, DEFAULT_AGENT_SCOPE_PATTERNS)

    def test_configured_scope_gates_every_runtime_hook(self) -> None:
        """An out-of-scope agent must see no QDM behaviour at all, even with a
        resolvable channel user."""
        config = _scoped_config(("harness-data-*",), session_secret_file=Path("missing.secret"), data_harness_cli=Path("missing-cli"))
        for factory in (QdmRequesterIdentityHook, QdmRequesterContextHook, QwenPawHarnessContextHook):
            outside = _AgentContext("wecom", {"is_group": False, "wecom_sender_id": "zhangsan"}, agent_id="coding")
            with patch.object(RUNTIME_HOOKS_MODULE, "load_config", return_value=config):
                result = asyncio.run(factory().run(outside))
            self.assertIsNone(result.payload, factory.__name__)
            self.assertEqual(outside.injected, [], factory.__name__)
            self.assertNotIn("qdm_harness_requester_token", outside.extras, factory.__name__)
            self.assertEqual(outside.request.request_context, {}, factory.__name__)

        # Positive control: the same request on an in-scope agent does bind.
        inside = _AgentContext("wecom", {"is_group": False, "wecom_sender_id": "zhangsan"}, agent_id="harness-data-east")
        with patch.object(RUNTIME_HOOKS_MODULE, "load_config", return_value=config):
            asyncio.run(QdmRequesterIdentityHook().run(inside))
        self.assertIn("qdm_requester", inside.request.request_context)

    def test_wildcard_match_on_the_shared_default_agent_warns_once(self) -> None:
        registry = ToolRegistry()
        workspace = types.SimpleNamespace(plugins=types.SimpleNamespace(tool_registry=registry))
        info = {"agent_id": "default", "workspace": workspace}
        specs = (("qdm_query", lambda: None, True, "d", ""),)
        PLUGIN_MODULE._SHARED_AGENT_WARNINGS.clear()
        try:
            with patch.object(PLUGIN_MODULE, "load_config", return_value=_scoped_config(("*",))):
                with self.assertLogs("qwenpaw.plugins.qdm_harness", level="WARNING") as logs:
                    PLUGIN_MODULE._apply_agent_scope_to_workspace(info, specs)
                    PLUGIN_MODULE._apply_agent_scope_to_workspace(info, specs)
            self.assertIn("qdm_query", registry.names())
            self.assertEqual(sum("built-in 'default' agent" in line for line in logs.output), 1)
        finally:
            PLUGIN_MODULE._SHARED_AGENT_WARNINGS.clear()

    def test_out_of_scope_agent_has_its_stale_tool_entry_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            agent_file = workspace / "agent.json"
            agent_file.write_text(json.dumps({"name": "Default", "tools": {"builtin_tools": {
                "qdm_query": {"name": "qdm_query", "enabled": True},
                "web_search": {"name": "web_search", "enabled": True},
            }}}), encoding="utf-8")
            before = agent_file.stat().st_mode

            PLUGIN_MODULE._sync_registered_tool_entries("default", workspace, ("qdm_query",), False)
            data = json.loads(agent_file.read_text(encoding="utf-8"))
            self.assertFalse(data["tools"]["builtin_tools"]["qdm_query"]["enabled"])
            self.assertTrue(data["tools"]["builtin_tools"]["web_search"]["enabled"], "must not touch other tools")
            self.assertTrue(data["name"] == "Default", "must preserve the rest of agent.json")
            self.assertEqual(agent_file.stat().st_mode, before, "must preserve the file mode")

            # Already correct: the file is left untouched, so no rewrite churn.
            agent_file.write_text(agent_file.read_text(encoding="utf-8") + "  \n", encoding="utf-8")
            PLUGIN_MODULE._sync_registered_tool_entries("default", workspace, ("qdm_query",), False)
            self.assertTrue(agent_file.read_text(encoding="utf-8").endswith("  \n"))

            # An entry that omits ``enabled`` reads as enabled, matching the host gate.
            agent_file.write_text(json.dumps({"tools": {"builtin_tools": {"qdm_scope_summary": {"name": "qdm_scope_summary"}}}}), encoding="utf-8")
            PLUGIN_MODULE._sync_registered_tool_entries("default", workspace, ("qdm_scope_summary",), False)
            self.assertFalse(json.loads(agent_file.read_text(encoding="utf-8"))["tools"]["builtin_tools"]["qdm_scope_summary"]["enabled"])

    def test_tool_entry_sync_never_creates_a_missing_agent_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            missing = Path(temp) / "nope"
            missing.mkdir()
            PLUGIN_MODULE._sync_registered_tool_entries("coding", missing, ("qdm_query",), False)
            self.assertFalse((missing / "agent.json").exists())
            PLUGIN_MODULE._sync_registered_tool_entries("coding", "", ("qdm_query",), False)
            PLUGIN_MODULE._sync_registered_tool_entries("coding", None, ("qdm_query",), False)

    def test_a_symlinked_agent_file_is_not_written_through(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            outside = Path(temp) / "outside.json"
            outside.write_text(json.dumps({"tools": {"builtin_tools": {"qdm_query": {"enabled": True}}}}), encoding="utf-8")
            workspace = Path(temp) / "ws"
            workspace.mkdir()
            (workspace / "agent.json").symlink_to(outside)
            PLUGIN_MODULE._sync_registered_tool_entries("default", workspace, ("qdm_query",), False)
            self.assertTrue(json.loads(outside.read_text(encoding="utf-8"))["tools"]["builtin_tools"]["qdm_query"]["enabled"])

    def test_an_unusable_config_hides_the_tools(self) -> None:
        registry = ToolRegistry()
        registry.register(ToolDescriptor(name="qdm_query", func=lambda: None, description=""))
        workspace = types.SimpleNamespace(plugins=types.SimpleNamespace(tool_registry=registry))
        with patch.object(PLUGIN_MODULE, "load_config", side_effect=ConfigError("plugin config is unavailable")):
            PLUGIN_MODULE._apply_agent_scope_to_workspace({"agent_id": "harness-data-east", "workspace": workspace}, (("qdm_query", lambda: None, True, "d", ""),))
        self.assertEqual(registry.names(), [])


class ToolBoundaryTests(unittest.TestCase):
    def test_structured_query_builds_one_filter_argument_per_dimension(self) -> None:
        args = _query_args(
            metric="profitRate",
            start_date="2026-08-24",
            end_date="2026-08-24",
            statistic_policy="SUMMARY",
            agg_dims=["bizDate"],
            filters={"manageAreaId": ["CN01"], "categoryLevel1Id": ["11"]},
            time_grain=None,
            order_by=None,
            page_size=None,
            curr_page=None,
            yoy=False,
            mom=False,
        )
        self.assertEqual(args.count("--filter"), 2)
        self.assertIn("manageAreaId=CN01", args)
        self.assertIn("categoryLevel1Id=11", args)

    def test_structured_query_rejects_invalid_metric_and_filters_before_cli(self) -> None:
        base = dict(
            metric="profitRate", start_date="2026-08-24", end_date="2026-08-24", statistic_policy="SUMMARY",
            agg_dims=["bizDate"], filters={}, time_grain=None, order_by=None, page_size=None, curr_page=None, yoy=False, mom=False,
        )
        for updates in ({"metric": "store-gross-margin"}, {"filters": {"manageAreaId,categoryLevel1Id": ["CN01"]}}, {"filters": {"manageAreaId": ["CN01,11"]}}):
            with self.assertRaises(QdmCliError):
                _query_args(**(base | updates))

    def test_cli_only_receives_plugin_owned_authentication_flags(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli, harness = _cli_pair(temp)
            executor = QdmCliExecutor(cli, harness_cli=harness)
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=_routed_run(_allow_envelope(SCOPE_CN01))) as run:
                executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
            argv = run.call_args_list[-1].args[0]
            self.assertEqual(argv[:3], [str(cli), "analysis", "execute"])
            self.assertEqual(argv[-3:], ["--data-auth", "--auth-blob", "qdm1enc.trusted"])

    def test_query_resolves_authorized_display_name_through_authz_hook(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli, harness = _cli_pair(temp)
            executor = QdmCliExecutor(cli, harness_cli=harness)
            envelope = _allow_envelope(SCOPE_AREA001, {"manageAreaId": ["AREA_001"]})
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=_routed_run(envelope)) as run:
                executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", filters={"manageAreaId": ["粤东区"]}, blob="qdm1enc.trusted")
            self.assertIn("authz-hook", run.call_args_list[0].args[0])
            self.assertIn("manageAreaId=AREA_001", run.call_args_list[-1].args[0])

    def test_labels_unresolved_allows_id_only_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli, harness = _cli_pair(temp)
            executor = QdmCliExecutor(cli, harness_cli=harness)
            scope = {"enabled": True, "capabilities": ["qdm.metric.query"], "labelsResolved": False,
                     "dataScope": {"manageAreaId": [{"id": "AREA_001", "name": ""}], "sapArea2Id": [{"id": "CN01", "name": ""}]}}
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=_routed_run(_allow_envelope(scope))):
                loaded = executor.preflight_query("qdm1enc.test")
            self.assertFalse(loaded.labels_resolved)
            self.assertEqual(loaded.data_scope["manageAreaId"][0].id, "AREA_001")
            self.assertEqual(loaded.data_scope["manageAreaId"][0].name, "")

    def test_query_rejects_unauthorized_name_without_analysis_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli, harness = _cli_pair(temp)
            executor = QdmCliExecutor(cli, harness_cli=harness)
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=_routed_run(_deny_envelope("QDM_AREA_OUTSIDE_DATA_SCOPE: 请求的管理区域不在当前用户授权范围内"))) as run:
                with self.assertRaises(QdmCliError) as raised:
                    executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", filters={"manageAreaId": ["华南区"]}, blob="qdm1enc.trusted")
            self.assertEqual(raised.exception.code, "QDM_AREA_OUTSIDE_DATA_SCOPE")
            self.assertEqual(run.call_count, 1)

    def test_store_name_is_resolved_only_from_authorized_store_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli, harness = _cli_pair(temp)
            executor = QdmCliExecutor(cli, harness_cli=harness)
            envelope = _allow_envelope(SCOPE_STORE, {"storeId": ["S001"]})
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=_routed_run(envelope)) as run:
                executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24",
                               filters={"storeId": ["广州时代玫瑰"]}, blob="qdm1enc.trusted")
            self.assertIn("storeId=S001", run.call_args_list[-1].args[0])

    def test_store_name_without_authorized_store_scope_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli, harness = _cli_pair(temp)
            executor = QdmCliExecutor(cli, harness_cli=harness)
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=_routed_run(_deny_envelope("QDM_STORE_OUTSIDE_DATA_SCOPE: 请求的门店不在当前用户授权范围内"))) as run:
                with self.assertRaises(QdmCliError) as raised:
                    executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24",
                                   filters={"storeId": ["广州时代玫瑰"]}, blob="qdm1enc.trusted")
            self.assertEqual(raised.exception.code, "QDM_STORE_OUTSIDE_DATA_SCOPE")
            self.assertEqual(run.call_count, 1)

    def test_cli_success_output_redacts_an_unexpected_blob_echo(self) -> None:
        self.assertEqual(_truncate_success("result qdm1enc.sensitive-value"), "result [REDACTED]")

    def test_cli_success_output_is_complete_by_default_and_rejects_configured_overflow(self) -> None:
        value = "{" + "x" * (64 * 1024) + "}"
        self.assertEqual(_truncate_success(value), value)
        with self.assertRaises(QdmCliError) as raised:
            _truncate_success(value, limit=1024)
        self.assertEqual(raised.exception.code, "QDM_RESULT_TOO_LARGE")

    def test_execute_error_is_safe_and_does_not_leak_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli, harness = _cli_pair(temp)
            executor = QdmCliExecutor(cli, harness_cli=harness)
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=_routed_run(
                _allow_envelope(SCOPE_CN01),
                execute_rc=1,
                execute_out="fallback FILTER_OUTSIDE_DATA_SCOPE",
                execute_err=json.dumps({"code": "FILTER_OUTSIDE_DATA_SCOPE", "message": "qdm1enc.secret requestId=abc"}),
            )):
                with self.assertRaises(QdmCliError) as raised:
                    executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
            self.assertEqual(raised.exception.code, "QDM_CLI_VALIDATION_FAILED")
            self.assertNotIn("qdm1enc", str(raised.exception))
            self.assertNotIn("requestId=abc", str(raised.exception))

    def test_execute_unknown_error_is_safe(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli, harness = _cli_pair(temp)
            executor = QdmCliExecutor(cli, harness_cli=harness)
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=_routed_run(
                _allow_envelope(SCOPE_CN01),
                execute_rc=1,
                execute_out="PROVIDER_SECRET requestId=abc",
                execute_err="not json",
            )):
                with self.assertRaises(QdmCliError) as raised:
                    executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
            self.assertEqual(raised.exception.code, "QDM_CLI_VALIDATION_FAILED")
            self.assertNotIn("PROVIDER_SECRET", str(raised.exception))
            self.assertNotIn("requestId", str(raised.exception))

    def test_authz_deny_envelope_is_surfaced_without_extra_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli, harness = _cli_pair(temp)
            executor = QdmCliExecutor(cli, harness_cli=harness)
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=_routed_run(
                _deny_envelope("QDM_AUTH_CAPABILITY_DENIED: 当前用户没有 QDM 数据查询权限"),
            )) as run:
                with self.assertRaises(QdmCliError) as raised:
                    executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
            self.assertEqual(raised.exception.code, "QDM_AUTH_CAPABILITY_DENIED")
            self.assertEqual(run.call_count, 1)

    def test_report_lifecycle_accepts_only_bounded_structured_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "data-harness-cli.exe"
            cli.parent.mkdir()
            _write_placeholder_cli(cli)
            completed = types.SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"ok": True, "additional_context": "template body", "mode": "report", "selected_template": "templates/report.md", "diagnostic_code": "template_injected"}),
                stderr="",
            )
            with patch("qdm_harness_qwenpaw_test.qdm_report_lifecycle.subprocess.run", return_value=completed) as run:
                result = complete_qdm_query(cli, "qwenpaw:" + "a" * 64, report_name="financial-overview", report_module="indicators")
            self.assertEqual(result, LifecycleResult("template body", "template_injected", True))
            payload = json.loads(run.call_args.kwargs["input"])
            self.assertEqual(payload["tool_name"], "qdm_query")
            self.assertEqual(payload["safe_command_args"], {"report_name": "financial-overview", "report_module": "indicators"})

    def test_report_lifecycle_fails_closed_on_malformed_or_oversized_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "data-harness-cli.exe"
            cli.parent.mkdir()
            _write_placeholder_cli(cli)
            cases = (("not json", None), (json.dumps({"ok": True, "additional_context": "x" * (256 * 1024 + 1), "diagnostic_code": "template_injected"}), 1024), (json.dumps({"ok": "yes", "additional_context": "x", "diagnostic_code": "bad"}), None))
            for stdout, limit in cases:
                completed = types.SimpleNamespace(returncode=0, stdout=stdout, stderr="")
                with patch("qdm_harness_qwenpaw_test.qdm_report_lifecycle.subprocess.run", return_value=completed):
                    result = complete_qdm_query(cli, "qwenpaw:" + "b" * 64, report_name=None, report_module=None, additional_context_bytes=limit)
                self.assertIn(result.diagnostic_code, {"QDM_REPORT_LIFECYCLE_UNAVAILABLE", "QDM_REPORT_CONTEXT_INVALID", "QDM_REPORT_CONTEXT_TOO_LARGE", "bad"})

    def test_query_tool_returns_qwenpaw_error_state_for_a_rejected_request(self) -> None:
        class Api:
            def __init__(self) -> None:
                self.tools: dict[str, object] = {}

            def register_runtime_hook(self, _hook: object = None, **_kwargs: object) -> None:
                pass

            def register_tool(self, **kwargs: object) -> None:
                self.tools[str(kwargs["tool_name"])] = kwargs["tool_func"]

        api = Api()
        QdmHarnessQwenPawPlugin().register(api)  # type: ignore[arg-type]
        query = api.tools["qdm_query"]
        token = requester_context.set(Requester(1, "resolved", "wecom", "zhangsan", "single"))
        try:
            with patch.object(PLUGIN_MODULE, "_trusted_components", side_effect=QdmCliError("QDM_CLI_UNAVAILABLE", "QDM CLI 不可用")):
                result = asyncio.run(query(metric="profitRate", start_date="2026-08-24", end_date="2026-08-24"))  # type: ignore[operator]
        finally:
            requester_context.reset(token)
        self.assertEqual(result.state, ToolResultState.ERROR)
        self.assertIn("QDM_CLI_UNAVAILABLE", result.content[0].text)

    def test_reload_safe_hook_applies_agent_scope_to_replacement_workspace(self) -> None:
        from qwenpaw.runtime.tool_registry import ToolDescriptor, ToolRegistry

        class Api:
            def __init__(self) -> None:
                self.tools: dict[str, object] = {}
                self.workspace_hooks: list = []

            def register_runtime_hook(self, _hook: object = None, **_kwargs: object) -> None:
                pass

            def register_tool(self, **kwargs: object) -> None:
                self.tools[str(kwargs["tool_name"])] = kwargs["tool_func"]

            def register_workspace_created_hook(self, **kwargs: object) -> None:
                self.workspace_hooks.append(kwargs)

        api = Api()
        QdmHarnessQwenPawPlugin().register(api)  # type: ignore[arg-type]
        self.assertEqual(len(api.workspace_hooks), 1)
        self.assertTrue(api.workspace_hooks[0]["reload_safe"])

        # A replacement workspace (zero-downtime reload) starts with an empty
        # ToolRegistry; the reload-safe hook must restore the qdm tools, but only
        # for an agent inside the configured scope.
        with patch.object(PLUGIN_MODULE, "load_config", return_value=_scoped_config(("harness-data-*",))):
            served = ToolRegistry()
            api.workspace_hooks[0]["callback"](  # type: ignore[operator]
                {"agent_id": "harness-data-east", "workspace_dir": "/tmp", "workspace": types.SimpleNamespace(plugins=types.SimpleNamespace(tool_registry=served))},
            )
            self.assertIn("qdm_query", served.names())
            self.assertIn("qdm_scope_summary", served.names())
            self.assertTrue(served.get("qdm_query").async_execution)

            other = ToolRegistry()
            other.register(ToolDescriptor(name="qdm_query", func=lambda: None, description=""))
            other.register(ToolDescriptor(name="qdm_scope_summary", func=lambda: None, description=""))
            api.workspace_hooks[0]["callback"](  # type: ignore[operator]
                {"agent_id": "default", "workspace_dir": "/tmp", "workspace": types.SimpleNamespace(plugins=types.SimpleNamespace(tool_registry=other))},
            )
            self.assertEqual(other.names(), [])

    def test_qwenpaw_21_reload_bridge_restores_identity_hooks_and_tools(self) -> None:
        from qwenpaw.runtime.hooks import HookRegistry
        from qwenpaw.runtime.tool_registry import ToolRegistry

        workspace = types.SimpleNamespace(
            agent_id="default",
            workspace_dir=Path("/tmp/qdm-reload-test"),
            plugins=types.SimpleNamespace(
                hook_registry=HookRegistry(),
                tool_registry=ToolRegistry(),
            ),
        )

        class Manager:
            def __init__(self) -> None:
                self.agents: dict[str, object] = {}
                self.reload_calls = 0

            async def reload_agent(self, agent_id: str) -> bool:
                self.reload_calls += 1
                self.agents[agent_id] = workspace
                return True

        class LegacyRegistry:
            def __init__(self, manager: Manager, registrations: list[object]) -> None:
                self.manager = manager
                self.registrations = registrations

            def get_workspace_manager(self) -> Manager:
                return self.manager

            def get_workspace_created_hooks(self) -> list[object]:
                return self.registrations

        async def qdm_query() -> None:
            return None

        async def qdm_scope_summary() -> None:
            return None

        manager = Manager()
        hook_specs = hook_factories()
        tool_specs = (
            ("qdm_query", qdm_query, True, "query", ""),
            ("qdm_scope_summary", qdm_scope_summary, True, "scope", ""),
        )

        def restore_hooks(workspace_info: dict[str, object]) -> None:
            target = workspace_info["workspace"]
            for _name, factory, _priority in hook_specs:
                target.plugins.hook_registry.register(factory())  # type: ignore[union-attr]

        def restore_tools(workspace_info: dict[str, object]) -> None:
            PLUGIN_MODULE._apply_agent_scope_to_workspace(workspace_info, tool_specs)

        unrelated_called: list[bool] = []
        registry = LegacyRegistry(manager, [
            types.SimpleNamespace(
                plugin_id="qdm-harness-qwenpaw",
                hook_name="rt_hook_ws_qdm-harness-qwenpaw_identity",
                callback=restore_hooks,
            ),
            types.SimpleNamespace(
                plugin_id="qdm-harness-qwenpaw",
                hook_name="qdm_harness_apply_agent_scope",
                callback=restore_tools,
            ),
            types.SimpleNamespace(
                plugin_id="other-plugin",
                hook_name="rt_hook_ws_other-plugin_hook",
                callback=lambda _info: unrelated_called.append(True),
            ),
        ])

        self.assertTrue(PLUGIN_MODULE._install_legacy_reload_bridge(registry=registry))
        self.assertTrue(PLUGIN_MODULE._install_legacy_reload_bridge(registry=registry))
        with patch.object(PLUGIN_MODULE, "load_config", return_value=_scoped_config(("default",))):
            self.assertTrue(asyncio.run(manager.reload_agent("default")))
        self.assertEqual(manager.reload_calls, 1)
        self.assertEqual(unrelated_called, [])
        pre_build_names = {
            hook.name for hook in workspace.plugins.hook_registry.hooks_for(Phase.PRE_AGENT_BUILD)
        }
        pre_execute_names = {
            hook.name for hook in workspace.plugins.hook_registry.hooks_for(Phase.PRE_EXECUTE)
        }
        self.assertIn("qdm_harness.requester_identity", pre_build_names)
        self.assertIn("qdm_harness.requester_bind", pre_execute_names)
        self.assertIn("qdm_query", workspace.plugins.tool_registry.names())
        self.assertIn("qdm_scope_summary", workspace.plugins.tool_registry.names())

    def test_reload_bridge_reports_when_the_host_renames_its_bridges(self) -> None:
        """A renamed host bridge must not let the bridge log a false success."""
        from qwenpaw.runtime.tool_registry import ToolRegistry

        workspace = types.SimpleNamespace(
            agent_id="default",
            workspace_dir=Path("/tmp/qdm-reload-renamed"),
            plugins=types.SimpleNamespace(tool_registry=ToolRegistry()),
        )

        class Manager:
            def __init__(self) -> None:
                self.agents: dict[str, object] = {}

            async def reload_agent(self, agent_id: str) -> bool:
                self.agents[agent_id] = workspace
                return True

        class RenamedRegistry:
            """Serves only foreign bridge names, so the replay matches nothing."""

            def __init__(self, manager: Manager) -> None:
                self.manager = manager

            def get_workspace_manager(self) -> Manager:
                return self.manager

            def get_workspace_created_hooks(self) -> list[object]:
                return [types.SimpleNamespace(
                    plugin_id="qdm-harness-qwenpaw",
                    hook_name="ws_rt_bridge_v3_qdm-harness-qwenpaw_identity",
                    callback=lambda _info: None,
                )]

        manager = Manager()
        with self.assertLogs("qwenpaw.plugins.qdm_harness", level="WARNING") as logs:
            self.assertTrue(PLUGIN_MODULE._install_legacy_reload_bridge(registry=RenamedRegistry(manager)))
            with patch.object(PLUGIN_MODULE, "load_config", return_value=_scoped_config(("default",))):
                self.assertTrue(asyncio.run(manager.reload_agent("default")))
        captured = "\n".join(logs.output)
        self.assertIn("qdm_reload_bridge_incomplete", captured)
        self.assertIn("qdm_harness_apply_agent_scope", captured)
        self.assertIn("qdm_reload_tools_missing", captured)

    def test_reload_safe_hook_skips_when_no_workspace_is_resolvable(self) -> None:
        class Api:
            def __init__(self) -> None:
                self.workspace_hooks: list = []

            def register_runtime_hook(self, _hook: object = None, **_kwargs: object) -> None:
                pass

            def register_tool(self, **kwargs: object) -> None:
                pass

            def register_workspace_created_hook(self, **kwargs: object) -> None:
                self.workspace_hooks.append(kwargs)

        api = Api()
        QdmHarnessQwenPawPlugin().register(api)  # type: ignore[arg-type]
        # No workspace key and no resolvable manager: must be a no-op, not a crash.
        api.workspace_hooks[0]["callback"](  # type: ignore[operator]
            {"agent_id": "default", "workspace_dir": "/tmp"},
        )

    def test_workspace_hook_falls_back_when_host_rejects_reload_safe(self) -> None:
        class Api:
            def __init__(self) -> None:
                self.tools: dict[str, object] = {}
                self.workspace_hooks: list = []

            def register_runtime_hook(self, _hook: object = None, **_kwargs: object) -> None:
                pass

            def register_tool(self, **kwargs: object) -> None:
                self.tools[str(kwargs["tool_name"])] = kwargs["tool_func"]

            def register_workspace_created_hook(self, **kwargs: object) -> None:
                if "reload_safe" in kwargs:
                    raise TypeError("unexpected keyword argument 'reload_safe'")
                self.workspace_hooks.append(kwargs)

        api = Api()
        QdmHarnessQwenPawPlugin().register(api)  # type: ignore[arg-type]
        self.assertEqual(len(api.workspace_hooks), 1)
        self.assertNotIn("reload_safe", api.workspace_hooks[0])
        self.assertEqual(api.workspace_hooks[0]["hook_name"], "qdm_harness_apply_agent_scope")

    def test_authorization_snapshot_reuse_keeps_the_executor_available(self) -> None:
        """A reused scope must never come back without live components."""
        requester = Requester(1, "resolved", "wecom", "zhangsan", "single")
        recorder = _QdmRecorder()
        snapshot = PLUGIN_MODULE.AuthorizationSnapshot(
            requester, "qdm1enc.blob", recorder.scope(), "cred-fp", "scope-fp",
        )
        requester_token = requester_context.set(requester)
        snapshot_token = RUNTIME_HOOKS_MODULE.authorization_snapshot_context.set(snapshot)
        try:
            with patch.object(PLUGIN_MODULE, "load_config", _component_config), \
                    patch.object(PLUGIN_MODULE, "ChannelAuthProvider", lambda *_a, **_k: recorder), \
                    patch.object(PLUGIN_MODULE, "QdmCliExecutor", lambda *_a, **_k: recorder):
                provider, executor, _config = PLUGIN_MODULE._trusted_components()
            self.assertIsNotNone(provider)
            self.assertIsNotNone(executor)
            self.assertEqual(recorder.preflights, 0)
        finally:
            RUNTIME_HOOKS_MODULE.authorization_snapshot_context.reset(snapshot_token)
            requester_context.reset(requester_token)

    def test_two_queries_in_one_context_both_succeed_and_reuse_the_scope(self) -> None:
        """The host copies per-call contexts; this pins the same-context case."""
        requester = Requester(1, "resolved", "wecom", "zhangsan", "single")
        recorder = _QdmRecorder()
        requester_token = requester_context.set(requester)
        snapshot_token = RUNTIME_HOOKS_MODULE.authorization_snapshot_context.set(None)
        try:
            with patch.object(PLUGIN_MODULE, "load_config", _component_config), \
                    patch.object(PLUGIN_MODULE, "ChannelAuthProvider", lambda *_a, **_k: recorder), \
                    patch.object(PLUGIN_MODULE, "QdmCliExecutor", lambda *_a, **_k: recorder):
                first = PLUGIN_MODULE._query(metric="saleAmt", start_date="2026-08-01", end_date="2026-08-02")
                second = PLUGIN_MODULE._query(metric="profitRate", start_date="2026-08-01", end_date="2026-08-02")
            self.assertEqual(first.state, ToolResultState.SUCCESS)
            self.assertEqual(second.state, ToolResultState.SUCCESS)
            self.assertEqual(recorder.preflights, 1)
            self.assertEqual(recorder.queries, 2)
        finally:
            RUNTIME_HOOKS_MODULE.authorization_snapshot_context.reset(snapshot_token)
            requester_context.reset(requester_token)

    def test_qdm_tools_reject_an_unbound_console_request_before_reading_config(self) -> None:
        token = requester_context.set(None)
        try:
            with patch.object(PLUGIN_MODULE, "load_config", side_effect=AssertionError("must not read config")):
                with self.assertRaisesRegex(QdmCliError, "QDM_HARNESS_HOOK_NOT_BOUND"):
                    PLUGIN_MODULE._trusted_components()
        finally:
            requester_context.reset(token)

    def test_an_unresolved_channel_request_keeps_the_unavailable_code(self) -> None:
        requester = Requester(1, "unavailable", "wecom", "", "group", reason="missing_or_non_person_sender")
        token = requester_context.set(requester)
        try:
            with patch.object(PLUGIN_MODULE, "load_config", side_effect=AssertionError("must not read config")):
                with self.assertRaisesRegex(QdmCliError, "QDM_CHANNEL_IDENTITY_UNAVAILABLE"):
                    PLUGIN_MODULE._trusted_components()
        finally:
            requester_context.reset(token)

    def test_debug_command_is_local_and_default_off(self) -> None:
        requester = Requester(1, "resolved", "feishu", "ou_123", "single")
        disabled = debug_result(_Context(DEBUG_COMMAND), requester, "off")
        self.assertEqual(disabled.action, HookAction.SHORT_CIRCUIT)
        self.assertIsNone(disabled.payload)
        enabled = debug_result(_Context(DEBUG_COMMAND), requester, "command")
        self.assertEqual(enabled.action, HookAction.SHORT_CIRCUIT)
        self.assertIn("ou_123", enabled.payload.get_text_content())

    def test_debug_command_explains_an_unrun_identity_hook(self) -> None:
        record_reload_bridge_state("unavailable")
        try:
            result = debug_result(_Context(DEBUG_COMMAND), None, "command")
        finally:
            record_reload_bridge_state("unknown")
        text = result.payload.get_text_content()
        self.assertIn("身份解析钩子：未运行", text)
        self.assertIn("热重载兼容桥：未安装", text)

    def test_debug_command_reports_the_bridge_outcome(self) -> None:
        requester = Requester(1, "resolved", "wecom", "zhangsan", "single")
        record_reload_bridge_state("not_needed")
        try:
            text = debug_result(_Context(DEBUG_COMMAND), requester, "command").payload.get_text_content()
        finally:
            record_reload_bridge_state("unknown")
        self.assertIn("zhangsan", text)
        self.assertIn("热重载兼容桥：不需要", text)

    def test_debug_command_only_explains_group_rejection_in_command_mode(self) -> None:
        requester = Requester(1, "unavailable", "wecom", "", "group", reason="group_not_confirmed_mentioned")
        result = debug_result(_Context(DEBUG_COMMAND), requester, "command")
        self.assertIn("受信任的 @机器人", result.payload.get_text_content())

    def test_factories_cover_required_phases(self) -> None:
        hooks = [(name, factory(), priority) for name, factory, priority in hook_factories()]
        phases = {hook.phase for _, hook, _ in hooks}
        self.assertTrue({Phase.PRE_AGENT_BUILD, Phase.PRE_EXECUTE, Phase.POST_RESPONSE, Phase.ON_ERROR}.issubset(phases))
        self.assertEqual(len({hook.name for _, hook, _ in hooks}), len(hooks))


class HarnessContextTests(unittest.TestCase):
    def test_qwenpaw_context_replaces_file_read_instructions(self) -> None:
        sanitized = _sanitize_embedded_context_instruction("必须先读取以下 contextFiles：\nAll modes: read all contextFiles before running data CLI.")
        self.assertIn("禁止再次使用 Read", sanitized)
        self.assertIn("do not call Read", sanitized)

    def test_context_base_limit_is_applied_only_when_configured(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli = root / "bin" / "data-harness-cli.exe"
            cli.parent.mkdir()
            _write_placeholder_cli(cli)
            output = json.dumps({"hookSpecificOutput": {"additionalContext": "base context", "contextFiles": [{"path": "wikis/index.md"}]}})
            completed = types.SimpleNamespace(returncode=0, stdout=output, stderr="")
            with patch("qdm_harness_qwenpaw_test.qdm_harness_context.subprocess.run", return_value=completed):
                context = request_context(cli, "session", "prompt")
                self.assertIn("base context", context)
                self.assertIn("qdm_scope_summary", context)
                self.assertIn("never ask the user to run `qdm-metric-cli auth describe`", context)
                with self.assertRaisesRegex(HarnessContextError, "Harness 上下文不可用") as error:
                    request_context(cli, "session", "prompt", context_limits=ContextLimits(base_context_bytes=4))
            self.assertEqual(error.exception.reason, "context_base_too_large")

    def test_context_protocol_rejects_output_without_embedded_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "data-harness-cli.exe"
            _write_placeholder_cli(cli)
            completed = types.SimpleNamespace(returncode=0, stdout='{"unexpected": true}', stderr="")
            with patch("qdm_harness_qwenpaw_test.qdm_harness_context.subprocess.run", return_value=completed):
                with self.assertRaisesRegex(HarnessContextError, "Harness 上下文不可用") as error:
                    request_context(cli, "session", "prompt")
            self.assertEqual(error.exception.reason, "context_protocol_invalid")

    def test_context_cli_failure_diagnosis_does_not_return_cli_text(self) -> None:
        self.assertEqual(_context_cli_failure_reason("open .harness/index/wikis-index.json: no such file", ""), "missing_wiki_index")
        self.assertEqual(_context_cli_failure_reason("unexpected failure", ""), "context_cli_failed")


class ConsoleChannelTests(unittest.TestCase):
    def test_plugin_manifest_version_is_incremented(self) -> None:
        manifest = Path(__file__).parents[1] / "plugin.json"
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        self.assertEqual(payload["version"], "0.1.6")

    def test_pre_execute_rebinds_requester_from_current_channel_message(self) -> None:
        config = _scoped_config(("qdmDataAgent",), session_secret_file=Path("missing.secret"))
        ctx = _AgentContext("wecom", {"is_group": True, "wecom_sender_id": "user-1"})
        with patch.object(RUNTIME_HOOKS_MODULE, "load_config", return_value=config):
            async def exercise():
                await QdmRequesterContextHook().run(ctx)
                first = requester_context.get()
                token = ctx.extras.pop("qdm_harness_requester_token")
                requester_context.reset(token)
                ctx.request.channel_meta = {"is_group": True, "wecom_sender_id": "user-2"}
                await QdmRequesterContextHook().run(ctx)
                return first, requester_context.get()
            first, second = asyncio.run(exercise())
        self.assertEqual(first.user_id, "user-1")
        self.assertEqual(second.user_id, "user-2")
        self.assertEqual(ctx.request.request_context["qdm_requester"]["user_id"], "user-2")
    def test_console_allows_normal_reply_but_binds_no_qdm_requester(self) -> None:
        config = _scoped_config(("qdmDataAgent",))
        ctx = _AgentContext("console", {})
        with patch.object(RUNTIME_HOOKS_MODULE, "load_config", return_value=config):
            asyncio.run(QdmRequesterIdentityHook().run(ctx))
            result = asyncio.run(QwenPawHarnessContextHook().run(ctx))
            self.assertIsNone(result.payload)
            self.assertEqual(ctx.injected, [(UNAUTHORIZED_SESSION_CONSTRAINT, 100, "qdm-harness-channel-boundary")])
            asyncio.run(QdmRequesterContextHook().run(ctx))
            self.assertIsNone(requester_context.get())

    def test_unmentioned_group_remains_blocked_before_model_or_cli(self) -> None:
        config = _scoped_config(("qdmDataAgent",))
        ctx = _AgentContext("feishu", {"is_group": True, "feishu_sender_id": "ou_123"})
        with patch.object(RUNTIME_HOOKS_MODULE, "load_config", return_value=config):
            asyncio.run(QdmRequesterIdentityHook().run(ctx))
            result = asyncio.run(QwenPawHarnessContextHook().run(ctx))
        self.assertEqual(result.action, HookAction.SHORT_CIRCUIT)
        self.assertEqual(ctx.injected, [])


class HookLifecycleTests(unittest.TestCase):
    @unittest.skip("QwenPaw 宿主 HookRegistry 尚未提供 replace_plugin_hook/unregister_plugin_hooks API(2.1.0 与 2.2.0b3 均无); 属未来宿主能力契约测试")
    def test_host_replaces_and_unloads_only_this_plugins_hook_instances(self) -> None:
        class OtherPluginHook(HookBase):
            phase = Phase.PRE_AGENT_BUILD
            name = "other-plugin.identity"

            async def run(self, ctx: object):  # pragma: no cover - registration test only
                raise AssertionError("not executed")

        registry = HookRegistry()
        other = OtherPluginHook()
        old = QdmRequesterIdentityHook()
        old._plugin_id = "qdm-harness-qwenpaw"
        registry.register(other)
        registry.register(old)
        self.assertEqual(
            [hook.name for hook in registry.hooks_for(Phase.PRE_AGENT_BUILD)],
            ["qdm_harness.requester_identity", "other-plugin.identity"],
        )

        replacement = QdmRequesterIdentityHook()
        replacement._plugin_id = "qdm-harness-qwenpaw"
        self.assertEqual(registry.replace_plugin_hook("qdm-harness-qwenpaw", replacement), 1)
        hooks = registry.hooks_for(Phase.PRE_AGENT_BUILD)
        self.assertEqual(sum(hook.name == replacement.name for hook in hooks), 1)
        self.assertIn(other, hooks)
        self.assertIn(replacement, hooks)
        self.assertNotIn(old, hooks)

        self.assertEqual(registry.unregister_plugin_hooks("qdm-harness-qwenpaw"), 1)
        self.assertEqual(registry.hooks_for(Phase.PRE_AGENT_BUILD), [other])

    def test_plugin_only_uses_the_public_runtime_hook_registration_api(self) -> None:
        source = (ROOT / "plugin.py").read_text(encoding="utf-8")
        self.assertIn("register_runtime_hook", source)
        self.assertNotIn("register_runtime_hook_now", source)
        self.assertNotIn("hook_registry", source)
        self.assertNotIn("_sorted_cache", source)
        self.assertNotIn("replace_plugin_hook", source)

    def test_plugin_registers_all_hooks_with_the_public_api(self) -> None:
        class Api:
            def __init__(self) -> None:
                self.hooks: list[object] = []
                self.tools: list[str] = []

            def register_runtime_hook(self, hook: object, **kwargs: object) -> None:
                self.hooks.append(hook)

            def register_tool(self, **kwargs: object) -> None:
                self.tools.append(str(kwargs["tool_name"]))

        api = Api()
        QdmHarnessQwenPawPlugin().register(api)  # type: ignore[arg-type]
        self.assertEqual(len(api.hooks), len(hook_factories()))
        for hook in api.hooks:
            self.assertTrue(callable(getattr(hook, "run", None)))
            self.assertTrue(getattr(hook, "phase", None) is not None)
            self.assertTrue(getattr(hook, "name", None))
        self.assertEqual(api.tools, ["qdm_query", "qdm_scope_summary"])

    def test_plugin_restores_cli_exec_bits_for_zip_installed_layouts(self) -> None:
        if os.name == "nt":
            self.skipTest("POSIX exec bits are not applicable on Windows")
        with tempfile.TemporaryDirectory() as temp:
            plugin_root = Path(temp)
            scripts = plugin_root / "scripts"
            scripts.mkdir()
            shims = tuple(scripts / name for name in ("data-harness-cli", "harness-data"))
            for shim in shims:
                shim.write_text("#!/usr/bin/env node\n", encoding="utf-8")
                shim.chmod(0o644)  # QwenPaw backend zipfile.extractall drops exec bits
            with patch.object(PLUGIN_MODULE, "__file__", str(plugin_root / "plugin.py")):
                PLUGIN_MODULE._ensure_cli_executable()
            for shim in shims:
                self.assertTrue(shim.stat().st_mode & stat.S_IXUSR)
                self.assertFalse(shim.is_symlink())

    def test_qdm_query_public_contract_has_no_report_arguments(self) -> None:
        class Api:
            def register_runtime_hook(self, _hook: object = None, **_kwargs: object) -> None:
                pass

            def register_tool(self, **kwargs: object) -> None:
                if kwargs["tool_name"] == "qdm_query":
                    self.query = kwargs["tool_func"]

        api = Api()
        QdmHarnessQwenPawPlugin().register(api)  # type: ignore[arg-type]
        self.assertNotIn("report_name", inspect.signature(api.query).parameters)  # type: ignore[attr-defined]
        self.assertNotIn("report_module", inspect.signature(api.query).parameters)  # type: ignore[attr-defined]

    def test_plugin_startup_rejects_an_unsupported_qwenpaw_version(self) -> None:
        class Api:
            register_runtime_hook = staticmethod(lambda _hook: None)

        with patch("qdm_harness_qwenpaw_test.plugin.version", return_value="2.3.0"):
            with self.assertRaisesRegex(RuntimeError, "QwenPaw 2.1.x or 2.2.x"):
                QdmHarnessQwenPawPlugin().register(Api())  # type: ignore[arg-type]

    def test_plugin_startup_accepts_22x_and_prerelease_versions(self) -> None:
        class Api:
            def register_runtime_hook(self, _hook: object = None, **_kwargs: object) -> None:
                pass

            def register_tool(self, **_kwargs: object) -> None:
                pass

        for installed in ("2.1.0", "2.1.6", "2.2.0", "2.2.0b3"):
            with patch("qdm_harness_qwenpaw_test.plugin.version", return_value=installed):
                QdmHarnessQwenPawPlugin().register(Api())  # type: ignore[arg-type]


class InstallerTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows 工作目录路径语义(C:\\ 绝对路径仅在 Windows 成立)")
    def test_working_dir_uses_qwenpaw_reported_location_and_explicit_override(self) -> None:
        with patch.object(INSTALLER.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout="C:\\Users\\QDM\\.copaw\n")):
            self.assertEqual(INSTALLER._resolve_working_dir(sys.executable, ""), Path("C:/Users/QDM/.copaw"))
        explicit = Path(tempfile.mkdtemp())
        try:
            self.assertEqual(INSTALLER._resolve_working_dir(sys.executable, str(explicit)), explicit.resolve())
        finally:
            import shutil
            shutil.rmtree(explicit)

    def test_windows_install_scripts_are_part_of_the_plugin_source(self) -> None:
        command = (ROOT / "INSTALL-QWENPAW-COMMAND-DEBUG.cmd").read_text(encoding="utf-8")
        powershell = (ROOT / "INSTALL-QWENPAW-COMMAND-DEBUG.ps1").read_text(encoding="utf-8")
        acl = (ROOT / "prepare-qwenpaw-materials.ps1").read_text(encoding="utf-8")
        self.assertIn("-ExecutionPolicy Bypass", command)
        self.assertIn("install-qwenpaw-plugin.py", powershell)
        self.assertIn("SetAccessRuleProtection", acl)

    def _fixture(self) -> tuple[Path, Path, Path, Path, types.SimpleNamespace]:
        temp = Path(tempfile.mkdtemp())
        runtime = temp / "runtime"
        (runtime / "bin").mkdir(parents=True)
        suffix = ".exe" if os.name == "nt" else ""
        for name in (f"data-harness-cli{suffix}", f"qdm-metric-cli{suffix}"):
            _write_placeholder_cli(runtime / "bin" / name)
        working = temp / "qwenpaw"
        agent = working / "workspaces" / "qdmDataAgent" / "agent.json"
        agent.parent.mkdir(parents=True)
        agent.write_text(
            json.dumps({
                "tools": {
                    "builtin_tools": {
                        "execute_shell_command": {"enabled": True},
                        "get_current_time": {"enabled": False},
                    },
                },
            }),
            encoding="utf-8",
        )
        auth = runtime / "config" / "qwenpaw" / "channel-auth.json"
        secret = runtime / "config" / "qwenpaw" / "session-hmac.secret"
        config = temp / "secure" / "plugin-config.json"
        auth.parent.mkdir(parents=True)
        config.parent.mkdir(parents=True)
        auth.write_text(json.dumps({"credentials": {}, "channelUserIndex": {}}), encoding="utf-8")
        _make_sensitive(auth)
        secret.write_bytes(b"x" * 32)
        _make_sensitive(secret)
        args = types.SimpleNamespace(
            source=str(ROOT),
            runtime=str(runtime),
            python=sys.executable,
            working_dir=str(working),
            agent_id="qdmDataAgent",
            agent_config="",
            user_id_display_mode="off",
            tool_policy="strict",
        )
        return temp, agent, auth, secret, config, args

    def test_install_overwrites_allowlist_and_keeps_auth_materials_read_only(self) -> None:
        temp, agent, auth, secret, config, args = self._fixture()
        calls: list[list[str]] = []
        try:
            with (
                patch.object(INSTALLER, "DEFAULT_PLUGIN_CONFIG_FILE", config),
                patch.object(INSTALLER, "_validate_qwenpaw"),
                patch.object(INSTALLER, "_validate_windows_acl"),
                patch.object(INSTALLER, "_sensitive_material_paths", return_value=(auth, secret)),
                patch.object(INSTALLER, "_run_qwenpaw", side_effect=lambda _p, _w, command: calls.append(command)),
            ):
                INSTALLER.install(args)

            tools = json.loads(agent.read_text(encoding="utf-8"))["tools"]["builtin_tools"]
            enabled = {name for name, value in tools.items() if value.get("enabled") is True}
            self.assertEqual(enabled, set(INSTALLER.ALLOWED_TOOLS))
            installed_agent = json.loads(agent.read_text(encoding="utf-8"))
            self.assertFalse(installed_agent["light_context_config"]["tool_result_pruning_config"]["enabled"])
            self.assertEqual(json.loads(auth.read_text(encoding="utf-8")), {"credentials": {}, "channelUserIndex": {}})
            self.assertEqual(secret.read_bytes(), b"x" * 32)
            self.assertEqual([command[:2] for command in calls], [["plugin", "validate"], ["plugin", "install"]])
            written = json.loads(config.read_text(encoding="utf-8"))
            self.assertEqual(written["runtime_dir"], str(Path(args.runtime).resolve()))
            self.assertEqual(written["context_limits"], {"base_context_bytes": None, "wiki_file_bytes": None, "wiki_total_bytes": None})
        finally:
            import shutil
            shutil.rmtree(temp)

    def test_install_failure_restores_agent_and_plugin_configuration(self) -> None:
        temp, agent, auth, secret, config, args = self._fixture()
        original_agent = agent.read_bytes()
        config.write_text('{"before":"value"}\n', encoding="utf-8")
        original_config = config.read_bytes()
        try:
            with (
                patch.object(INSTALLER, "DEFAULT_PLUGIN_CONFIG_FILE", config),
                patch.object(INSTALLER, "_validate_qwenpaw"),
                patch.object(INSTALLER, "_validate_windows_acl"),
                patch.object(INSTALLER, "_sensitive_material_paths", return_value=(auth, secret)),
                patch.object(INSTALLER, "_run_qwenpaw", side_effect=RuntimeError("simulated failure")),
            ):
                with self.assertRaisesRegex(RuntimeError, "simulated failure"):
                    INSTALLER.install(args)

            self.assertEqual(agent.read_bytes(), original_agent)
            self.assertEqual(config.read_bytes(), original_config)
            self.assertEqual(json.loads(auth.read_text(encoding="utf-8")), {"credentials": {}, "channelUserIndex": {}})
            self.assertEqual(secret.read_bytes(), b"x" * 32)
        finally:
            import shutil
            shutil.rmtree(temp)

    def test_acl_parser_rejects_only_broad_read_entries(self) -> None:
        self.assertTrue(INSTALLER._has_read_permission("(I)(RX)"))
        self.assertTrue(INSTALLER._has_read_permission("(F)"))
        self.assertFalse(INSTALLER._has_read_permission("(W)"))

    def test_channel_auth_validation_rejects_a_broken_runtime_document(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "channel-auth.json"
            path.write_text('{"credentials": {}}', encoding="utf-8")
            with (
                patch.object(INSTALLER, "_validate_windows_acl"),
            ):
                with self.assertRaisesRegex(RuntimeError, "格式无效"):
                    INSTALLER._validate_channel_auth(path)


if __name__ == "__main__":
    unittest.main()
