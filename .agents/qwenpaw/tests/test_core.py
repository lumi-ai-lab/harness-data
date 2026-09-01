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
from qdm_harness_qwenpaw_test.qdm_debug_identity import DEBUG_COMMAND, debug_result
from qdm_harness_qwenpaw_test.qdm_harness_context import HarnessContextError, _context_cli_failure_reason, _selected_wiki_manuals, _sanitize_embedded_context_instruction, request_context, session_key
from qdm_harness_qwenpaw_test.qdm_identity import Requester, resolve_requester
from qdm_harness_qwenpaw_test.qdm_config import ConfigError, ContextLimits, QueryLimits, ReportLimits, load_config
from qdm_harness_qwenpaw_test.qdm_report_lifecycle import LifecycleResult, complete_qdm_query
from qdm_harness_qwenpaw_test.plugin import QdmHarnessQwenPawPlugin
from qdm_harness_qwenpaw_test.qdm_runtime_hooks import QdmRequesterContextHook, QdmRequesterIdentityHook, QwenPawHarnessContextHook, UNAUTHORIZED_SESSION_CONSTRAINT, hook_factories, requester_context
from qwenpaw.runtime.hooks import HookAction, HookBase, HookRegistry
from qwenpaw.runtime.phases import Phase
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
    def __init__(self, channel: str, channel_meta: dict[str, object], text: str = "你好") -> None:
        super().__init__(text)
        self.agent_id = "qdmDataAgent"
        self.request = _Request(channel, channel_meta)
        self.extras: dict[str, object] = {}
        self.injected: list[tuple[str, int, str]] = []

    def inject_context(self, content: str, *, priority: int, source: str) -> None:
        self.injected.append((content, priority, source))


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
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
            cli.parent.mkdir()
            _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            completed = types.SimpleNamespace(returncode=0, stdout=json.dumps({"enabled": True, "capabilities": ["qdm.metric.query"], "labelsResolved": True, "dataScope": {"manageAreaId": [{"id": "CN01", "name": "区域"}]}}), stderr="")
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=completed) as run:
                executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
            argv = run.call_args.args[0]
            self.assertEqual(argv[:3], [str(cli), "analysis", "execute"])
            self.assertEqual(argv[-3:], ["--data-auth", "--auth-blob", "qdm1enc.trusted"])

    def test_query_preflights_auth_and_resolves_authorized_display_name(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
            cli.parent.mkdir(); _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            responses = [
                types.SimpleNamespace(returncode=0, stdout=json.dumps({"enabled": True, "capabilities": ["qdm.metric.query"], "labelsResolved": True, "dataScope": {"manageAreaId": [{"id": "AREA_001", "name": "粤东区"}]}}), stderr=""),
                types.SimpleNamespace(returncode=0, stdout="{}", stderr=""),
            ]
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=responses) as run:
                executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", filters={"manageAreaId": ["粤东区"]}, blob="qdm1enc.trusted")
            self.assertEqual(run.call_args_list[0].args[0][1:3], ["auth", "describe"])
            self.assertIn("manageAreaId=AREA_001", run.call_args_list[1].args[0])

    def test_labels_unresolved_allows_id_only_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"; cli.parent.mkdir(); _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            response = types.SimpleNamespace(returncode=0, stdout=json.dumps({
                "enabled": True, "capabilities": ["qdm.metric.query"], "labelsResolved": False,
                "dataScope": {"manageAreaId": [{"id": "AREA_001", "name": ""}], "sapArea2Id": [{"id": "CN01", "name": ""}]},
            }), stderr="")
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=response):
                scope = executor.preflight_query("qdm1enc.test")
            self.assertFalse(scope.labels_resolved)
            self.assertEqual(scope.data_scope["manageAreaId"][0].id, "AREA_001")
            self.assertEqual(scope.data_scope["manageAreaId"][0].name, "")

    def test_query_rejects_unauthorized_name_without_analysis_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
            cli.parent.mkdir(); _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            response = types.SimpleNamespace(returncode=0, stdout=json.dumps({"enabled": True, "capabilities": ["qdm.metric.query"], "labelsResolved": True, "dataScope": {"manageAreaId": [{"id": "AREA_001", "name": "粤东区"}]}}), stderr="")
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=response) as run:
                with self.assertRaises(QdmCliError) as raised:
                    executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", filters={"manageAreaId": ["华南区"]}, blob="qdm1enc.trusted")
            self.assertEqual(raised.exception.code, "QDM_AREA_OUTSIDE_DATA_SCOPE")
            self.assertEqual(run.call_count, 1)

    def test_store_name_is_resolved_only_from_authorized_store_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
            cli.parent.mkdir(); _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            responses = [
                types.SimpleNamespace(returncode=0, stdout=json.dumps({
                    "enabled": True, "capabilities": ["qdm.metric.query"],
                    "labelsResolved": True,
                    "dataScope": {"manageAreaId": [{"id": "AREA_001", "name": "华南"}],
                                   "storeId": [{"id": "S001", "name": "广州时代玫瑰"}]},
                }), stderr=""),
                types.SimpleNamespace(returncode=0, stdout="{}", stderr=""),
            ]
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", side_effect=responses) as run:
                executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24",
                               filters={"storeId": ["广州时代玫瑰"]}, blob="qdm1enc.trusted")
            self.assertIn("storeId=S001", run.call_args_list[1].args[0])

    def test_store_name_without_authorized_store_scope_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
            cli.parent.mkdir(); _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            response = types.SimpleNamespace(returncode=0, stdout=json.dumps({
                "enabled": True, "capabilities": ["qdm.metric.query"],
                "labelsResolved": True,
                "dataScope": {"manageAreaId": [{"id": "AREA_001", "name": "华南"}]},
            }), stderr="")
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=response) as run:
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

    def test_cli_allowlisted_scope_error_is_stable_and_does_not_leak_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
            cli.parent.mkdir()
            _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            completed = types.SimpleNamespace(
                returncode=1,
                stdout="fallback FILTER_OUTSIDE_DATA_SCOPE",
                stderr=json.dumps({"code": "FILTER_OUTSIDE_DATA_SCOPE", "message": "qdm1enc.secret requestId=abc"}),
            )
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=completed):
                with self.assertRaises(QdmCliError) as raised:
                    executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
            self.assertEqual(raised.exception.code, "QDM_FILTER_OUTSIDE_DATA_SCOPE")
            self.assertEqual(raised.exception.message, "请求的数据范围不在当前用户授权范围内")
            self.assertNotIn("qdm1enc", str(raised.exception))
            self.assertNotIn("requestId", str(raised.exception))

    def test_cli_allowlisted_auth_errors_and_unknown_errors_are_classified_safely(self) -> None:
        expected = {
            "AUTH_CAPABILITY_DENIED": "QDM_AUTH_CAPABILITY_DENIED",
            "EMPTY_DATA_SCOPE": "QDM_EMPTY_DATA_SCOPE",
            "AUTH_USER_DISABLED": "QDM_AUTH_USER_DISABLED",
            "AUTH_BLOB_DECRYPT_FAIL": "QDM_CHANNEL_AUTH_DENIED",
            "AUTH_BLOB_INVALID": "QDM_CHANNEL_AUTH_DENIED",
        }
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
            cli.parent.mkdir()
            _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            for upstream, plugin_code in expected.items():
                completed = types.SimpleNamespace(returncode=1, stdout="", stderr=json.dumps({"error": {"code": upstream}}))
                with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=completed):
                    with self.assertRaises(QdmCliError) as raised:
                        executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
                self.assertEqual(raised.exception.code, plugin_code)
            completed = types.SimpleNamespace(returncode=1, stdout="PROVIDER_SECRET requestId=abc", stderr="not json")
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=completed):
                with self.assertRaises(QdmCliError) as raised:
                    executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
            self.assertEqual(raised.exception.code, "QDM_CLI_VALIDATION_FAILED")
            self.assertNotIn("PROVIDER_SECRET", str(raised.exception))
            self.assertNotIn("requestId", str(raised.exception))

    def test_cli_scope_error_preserves_only_an_allowlisted_dimension(self) -> None:
        cases = (
            ("manageAreaId", "QDM_AREA_OUTSIDE_DATA_SCOPE", "请求的管理区域不在当前用户授权范围内"),
            ("categoryLevel1Id", "QDM_CATEGORY_OUTSIDE_DATA_SCOPE", "请求的商品分类不在当前用户授权范围内"),
        )
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
            cli.parent.mkdir()
            _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            for dimension, expected_code, expected_message in cases:
                completed = types.SimpleNamespace(
                    returncode=1,
                    stdout="",
                    stderr=json.dumps({"code": "FILTER_OUTSIDE_DATA_SCOPE", "error": {"details": {"dimension": dimension, "requested": ["secret"], "requestId": "abc"}}}),
                )
                with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=completed):
                    with self.assertRaises(QdmCliError) as raised:
                        executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
                self.assertEqual(raised.exception.code, expected_code)
                self.assertEqual(raised.exception.message, expected_message)
                self.assertNotIn("secret", str(raised.exception))
            unknown = types.SimpleNamespace(
                returncode=1,
                stdout="",
                stderr=json.dumps({"code": "FILTER_OUTSIDE_DATA_SCOPE", "error": {"details": {"dimension": "storeId"}}}),
            )
            with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=unknown):
                with self.assertRaises(QdmCliError) as raised:
                    executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
            self.assertEqual(raised.exception.code, "QDM_FILTER_OUTSIDE_DATA_SCOPE")
            self.assertNotIn("storeId", str(raised.exception))

    def test_cli_empty_scope_error_maps_only_documented_claim_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
            cli.parent.mkdir()
            _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            for field, expected in (("manageAreaIds", "QDM_AREA_AUTH_SCOPE_EMPTY"), ("categoryLevel1Ids", "QDM_CATEGORY_AUTH_SCOPE_EMPTY")):
                completed = types.SimpleNamespace(returncode=1, stdout="", stderr=json.dumps({"code": "EMPTY_DATA_SCOPE", "error": {"details": {"claimField": field}}}))
                with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=completed):
                    with self.assertRaises(QdmCliError) as raised:
                        executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
                self.assertEqual(raised.exception.code, expected)

    def test_cli_dimension_errors_do_not_become_permission_errors(self) -> None:
        expected = {
            "DIMENSION_NOT_FOUND": "QDM_DIMENSION_NOT_FOUND",
            "DIMENSION_NOT_SUPPORTED": "QDM_DIMENSION_NOT_SUPPORTED",
            "INVALID_FILTER_VALUE": "QDM_FILTER_VALUE_INVALID",
            "DUPLICATE_FILTER_VALUE": "QDM_FILTER_VALUE_INVALID",
            "QUERY_LIMIT_EXCEEDED": "QDM_QUERY_INVALID",
        }
        with tempfile.TemporaryDirectory() as temp:
            cli = Path(temp) / "bin" / "qdm-metric-cli.exe"
            cli.parent.mkdir()
            _write_placeholder_cli(cli)
            executor = QdmCliExecutor(cli)
            for upstream, plugin_code in expected.items():
                completed = types.SimpleNamespace(returncode=1, stdout="", stderr=json.dumps({"code": upstream}))
                with patch("qdm_harness_qwenpaw_test.qdm_cli.subprocess.run", return_value=completed):
                    with self.assertRaises(QdmCliError) as raised:
                        executor.query(metric="saleAmt", start_date="2026-08-24", end_date="2026-08-24", blob="qdm1enc.trusted")
                self.assertEqual(raised.exception.code, plugin_code)

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

            def register_runtime_hook_now(self, **_kwargs: object) -> None:
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

    def test_qdm_tools_reject_an_unbound_console_request_before_reading_config(self) -> None:
        token = requester_context.set(None)
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
    def test_selected_wiki_manuals_reads_only_allowlisted_markdown_under_runtime_wikis(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            playbook = root / "wikis" / "metrics" / "profit" / "playbook.md"
            playbook.parent.mkdir(parents=True)
            playbook.write_text("metric: profitRate", encoding="utf-8")
            content = _selected_wiki_manuals(root, [{"path": "wikis/metrics/profit/playbook.md"}])
            self.assertIn("profitRate", content)

    def test_selected_wiki_manuals_rejects_paths_outside_wikis_and_templates(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "wikis").mkdir()
            for path in ("config/qwenpaw/channel-auth.json", "wikis/../config/qwenpaw/channel-auth.json", "wikis/templates/report.md"):
                with self.assertRaises(HarnessContextError):
                    _selected_wiki_manuals(root, [{"path": path}])

    def test_context_limits_default_to_unlimited_and_enforce_configured_file_or_total_limits(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "wikis" / "metrics" / "index.md"
            second = root / "wikis" / "reports" / "index.md"
            first.parent.mkdir(parents=True)
            second.parent.mkdir(parents=True)
            first.write_text("a" * 60, encoding="utf-8")
            second.write_text("b" * 30, encoding="utf-8")
            selected = [{"path": "wikis/metrics/index.md"}, {"path": "wikis/reports/index.md"}]
            self.assertIn("a" * 60, _selected_wiki_manuals(root, selected, context_limits=ContextLimits()))
            with self.assertRaisesRegex(HarnessContextError, "Harness 上下文不可用") as file_error:
                _selected_wiki_manuals(root, selected, context_limits=ContextLimits(wiki_file_bytes=50))
            self.assertEqual(file_error.exception.reason, "context_manuals_too_large")
            with self.assertRaisesRegex(HarnessContextError, "Harness 上下文不可用") as total_error:
                _selected_wiki_manuals(root, selected, context_limits=ContextLimits(wiki_total_bytes=80))
            self.assertEqual(total_error.exception.reason, "context_manuals_too_large")

    def test_context_base_limit_is_applied_only_when_configured(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli = root / "bin" / "data-harness-cli.exe"
            cli.parent.mkdir()
            _write_placeholder_cli(cli)
            wiki = root / "wikis" / "index.md"
            wiki.parent.mkdir()
            wiki.write_text("manual", encoding="utf-8")
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

    def test_context_cli_failure_diagnosis_does_not_return_cli_text(self) -> None:
        self.assertEqual(_context_cli_failure_reason("open .harness/index/wikis-index.json: no such file", ""), "missing_wiki_index")
        self.assertEqual(_context_cli_failure_reason("unexpected failure", ""), "context_cli_failed")


class ConsoleChannelTests(unittest.TestCase):
    def test_plugin_manifest_version_is_incremented(self) -> None:
        manifest = Path(__file__).parents[1] / "plugin.json"
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        self.assertEqual(payload["version"], "0.1.6")

    def test_pre_execute_rebinds_requester_from_current_channel_message(self) -> None:
        config = types.SimpleNamespace(qdm_agent_id="qdmDataAgent", session_secret_file=Path("missing.secret"))
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
        config = types.SimpleNamespace(qdm_agent_id="qdmDataAgent")
        ctx = _AgentContext("console", {})
        with patch.object(RUNTIME_HOOKS_MODULE, "load_config", return_value=config):
            asyncio.run(QdmRequesterIdentityHook().run(ctx))
            result = asyncio.run(QwenPawHarnessContextHook().run(ctx))
            self.assertIsNone(result.payload)
            self.assertEqual(ctx.injected, [(UNAUTHORIZED_SESSION_CONSTRAINT, 100, "qdm-harness-channel-boundary")])
            asyncio.run(QdmRequesterContextHook().run(ctx))
            self.assertIsNone(requester_context.get())

    def test_unmentioned_group_remains_blocked_before_model_or_cli(self) -> None:
        config = types.SimpleNamespace(qdm_agent_id="qdmDataAgent")
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
        self.assertIn("register_runtime_hook_now", source)
        self.assertNotIn("hook_registry", source)
        self.assertNotIn("_sorted_cache", source)
        self.assertNotIn("replace_plugin_hook", source)

    def test_plugin_registers_all_hooks_with_the_public_api(self) -> None:
        class Api:
            def __init__(self) -> None:
                self.hooks: list[dict[str, object]] = []
                self.tools: list[str] = []

            def register_runtime_hook_now(self, **kwargs: object) -> None:
                self.hooks.append(kwargs)

            def register_tool(self, **kwargs: object) -> None:
                self.tools.append(str(kwargs["tool_name"]))

        api = Api()
        QdmHarnessQwenPawPlugin().register(api)  # type: ignore[arg-type]
        self.assertEqual(len(api.hooks), len(hook_factories()))
        self.assertTrue(all(item["replace_legacy_same_name"] is False for item in api.hooks))
        self.assertEqual(api.tools, ["qdm_query", "qdm_scope_summary"])

    def test_qdm_query_public_contract_has_no_report_arguments(self) -> None:
        class Api:
            def register_runtime_hook_now(self, **_kwargs: object) -> None:
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
            register_runtime_hook_now = staticmethod(lambda **_kwargs: None)

        with patch("qdm_harness_qwenpaw_test.plugin.version", return_value="2.2.0"):
            with self.assertRaisesRegex(RuntimeError, "QwenPaw 2.1.x"):
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
                patch.object(INSTALLER, "_validate_linux_material"),
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
                patch.object(INSTALLER, "_validate_linux_material"),
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
                patch.object(INSTALLER, "_validate_linux_material"),
            ):
                with self.assertRaisesRegex(RuntimeError, "格式无效"):
                    INSTALLER._validate_channel_auth(path)


if __name__ == "__main__":
    unittest.main()
