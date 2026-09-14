from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "qdm_harness_qwenpaw_shell_test"
if PACKAGE not in sys.modules:
    package = types.ModuleType(PACKAGE)
    package.__path__ = [str(ROOT)]
    sys.modules[PACKAGE] = package

from qdm_harness_qwenpaw_shell_test.qdm_channel_auth import ChannelAuthorizationError
from qdm_harness_qwenpaw_shell_test.qdm_cli import QdmCliError, QdmCliExecutor
from qdm_harness_qwenpaw_shell_test.qdm_identity import Requester
from qdm_harness_qwenpaw_shell_test.qdm_runtime_hooks import authorization_snapshot_context, requester_context
from qdm_harness_qwenpaw_shell_test.qdm_shell_hook import QdmShellHookMiddleware, looks_like_qdm_command, shell_dialect
from agentscope.message import ToolResultState


class _Provider:
    def __init__(self, blob: str = "qdm1enc.secret-blob", error: Exception | None = None) -> None:
        self.blob = blob
        self.error = error
        self.calls = 0

    def blob_for(self, _requester: object) -> str:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.blob


class _Executor:
    def __init__(self, result: str | None = "qdm-metric-cli analysis execute --data-auth --auth-blob qdm1enc.secret-blob", error: QdmCliError | None = None) -> None:
        self.result = result
        self.error = error
        self.calls: list[dict[str, object]] = []

    def authorize_shell(self, **kwargs: object) -> str | None:
        self.calls.append(dict(kwargs))
        if self.error is not None:
            raise self.error
        return self.result


def _tool(command: str, name: str = "execute_shell_command", *, input_value: object | None = None) -> types.SimpleNamespace:
    return types.SimpleNamespace(name=name, input={"command": command} if input_value is None else input_value)


async def _collect(middleware: QdmShellHookMiddleware, tool_call: object) -> tuple[list[object], list[str]]:
    calls: list[str] = []

    async def next_handler(**kwargs: object):
        value = getattr(kwargs.get("tool_call"), "input", {})
        if isinstance(value, str):
            value = json.loads(value)
        calls.append(str(value.get("command")))
        yield types.SimpleNamespace(state=ToolResultState.SUCCESS, content=[])

    output = [
        item
        async for item in middleware.on_acting(None, {"tool_call": tool_call}, next_handler)
    ]
    return output, calls


def _requester() -> Requester:
    return Requester(1, "resolved", "wecom", "alice", "single")


def _set_context(requester: Requester | None = None, snapshot: object | None = None):
    requester_token = requester_context.set(requester)
    snapshot_token = authorization_snapshot_context.set(snapshot)
    return requester_token, snapshot_token


def _reset_context(tokens: tuple[object, object]) -> None:
    requester_context.reset(tokens[0])
    authorization_snapshot_context.reset(tokens[1])


class ShellHookMiddlewareTests(unittest.TestCase):
    def test_non_shell_tool_passes_through(self) -> None:
        provider = _Provider()
        executor = _Executor()
        output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), _tool("anything", "read_file")))
        self.assertEqual(len(output), 1)
        self.assertEqual(calls, ["anything"])
        self.assertEqual(provider.calls, 0)
        self.assertEqual(executor.calls, [])

    def test_non_qdm_shell_command_passes_through_without_blob_lookup(self) -> None:
        provider = _Provider()
        executor = _Executor()
        output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), _tool("echo hello")))
        self.assertEqual(len(output), 1)
        self.assertEqual(calls, ["echo hello"])
        self.assertEqual(provider.calls, 0)
        self.assertEqual(executor.calls, [])

    def test_path_qualified_qdm_commands_are_detected_conservatively(self) -> None:
        self.assertTrue(looks_like_qdm_command("/opt/qdm/bin/qdm-metric-cli analysis execute --measures-json []"))
        self.assertTrue(looks_like_qdm_command("& 'D:\\QDM\\bin\\qdm-metric-cli.exe' analysis execute --measures-json '[]'"))
        self.assertTrue(looks_like_qdm_command("D:\\QDM\\bin\\qdm-metric-cli.exe auth describe"))
        self.assertFalse(looks_like_qdm_command("echo qdm-metric-cli --help"))

    def test_allow_rewrites_command_and_calls_next_handler_once(self) -> None:
        provider = _Provider()
        executor = _Executor("trusted command")
        tokens = _set_context(_requester())
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="/bin/bash"):
                output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), _tool("qdm-metric-cli analysis execute --measures-json []")))
        finally:
            _reset_context(tokens)
        self.assertEqual(len(output), 1)
        self.assertEqual(calls, ["trusted command"])
        self.assertEqual(provider.calls, 1)
        self.assertEqual(executor.calls[0]["dialect"], "bash")

    def test_json_string_input_is_rewritten_and_written_back_as_json(self) -> None:
        provider = _Provider()
        executor = _Executor("trusted command")
        original = json.dumps({"command": "qdm-metric-cli analysis execute --measures-json []", "timeout": 30})
        tool = _tool("", input_value=original)
        tokens = _set_context(_requester())
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="/bin/bash"):
                output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), tool))
        finally:
            _reset_context(tokens)
        self.assertEqual(len(output), 1)
        self.assertEqual(calls, ["trusted command"])
        self.assertEqual(json.loads(tool.input), {"command": "trusted command", "timeout": 30})

    def test_invalid_json_string_input_is_denied_before_blob_lookup(self) -> None:
        provider = _Provider()
        executor = _Executor()
        output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), _tool("", input_value="{")))
        self.assertEqual(calls, [])
        self.assertEqual(provider.calls, 0)
        self.assertIn("QDM_AUTHZ_INPUT_INVALID", output[0].content[0].text)

    def test_json_array_input_is_denied(self) -> None:
        output, calls = asyncio.run(_collect(QdmShellHookMiddleware(_Provider(), _Executor(),), _tool("", input_value="[]")))
        self.assertEqual(calls, [])
        self.assertIn("QDM_AUTHZ_INPUT_INVALID", output[0].content[0].text)

    def test_json_string_noop_preserves_original_input(self) -> None:
        provider = _Provider()
        executor = _Executor(None)
        original = json.dumps({"command": "qdm-metric-cli auth describe", "timeout": 30})
        tool = _tool("", input_value=original)
        tokens = _set_context(_requester())
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="/bin/bash"):
                _output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), tool))
        finally:
            _reset_context(tokens)
        self.assertEqual(calls, ["qdm-metric-cli auth describe"])
        self.assertEqual(tool.input, original)

    def test_deny_does_not_call_next_handler_or_leak_blob(self) -> None:
        provider = _Provider()
        executor = _Executor(error=QdmCliError("QDM_MEASURES_JSON_REQUIRED", "missing qdm1enc.secret-blob"))
        tokens = _set_context(_requester())
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="powershell.exe"):
                output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), _tool("qdm-metric-cli analysis execute")))
        finally:
            _reset_context(tokens)
        self.assertEqual(calls, [])
        self.assertEqual(output[0].state, ToolResultState.DENIED)
        text = output[0].content[0].text
        self.assertIn("QDM_MEASURES_JSON_REQUIRED", text)
        self.assertNotIn("qdm1enc.secret-blob", text)

    def test_requester_missing_fails_closed_before_blob_lookup(self) -> None:
        provider = _Provider()
        executor = _Executor()
        tokens = _set_context(None)
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="/bin/bash"):
                output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), _tool("qdm-metric-cli auth describe")))
        finally:
            _reset_context(tokens)
        self.assertEqual(calls, [])
        self.assertEqual(provider.calls, 0)
        self.assertIn("QDM_CHANNEL_IDENTITY_UNAVAILABLE", output[0].content[0].text)

    def test_runtime_mcp_error_fails_closed(self) -> None:
        provider = _Provider(error=ChannelAuthorizationError("qdm1enc.secret-blob"))
        executor = _Executor()
        tokens = _set_context(_requester())
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="/bin/bash"):
                output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), _tool("qdm-metric-cli auth describe")))
        finally:
            _reset_context(tokens)
        self.assertEqual(calls, [])
        self.assertIn("QDM_CHANNEL_AUTH_DENIED", output[0].content[0].text)
        self.assertNotIn("qdm1enc.secret-blob", output[0].content[0].text)

    def test_configuration_error_fails_closed_with_stable_code(self) -> None:
        middleware = QdmShellHookMiddleware(None, None, initialization_error="QDM_CONFIG_INVALID")
        tokens = _set_context(_requester())
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="/bin/bash"):
                output, calls = asyncio.run(_collect(middleware, _tool("qdm-metric-cli auth describe")))
        finally:
            _reset_context(tokens)
        self.assertEqual(calls, [])
        self.assertIn("QDM_CONFIG_INVALID", output[0].content[0].text)

    def test_authorize_noop_passes_original_command_through(self) -> None:
        provider = _Provider()
        executor = _Executor(None)
        tokens = _set_context(_requester())
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="/bin/bash"):
                output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), _tool("qdm-metric-cli auth describe")))
        finally:
            _reset_context(tokens)
        self.assertEqual(len(output), 1)
        self.assertEqual(calls, ["qdm-metric-cli auth describe"])

    def test_unknown_or_disabled_dialect_fails_closed(self) -> None:
        provider = _Provider()
        executor = _Executor()
        tokens = _set_context(_requester())
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="zsh"):
                output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), _tool("qdm-metric-cli auth describe")))
        finally:
            _reset_context(tokens)
        self.assertEqual(calls, [])
        self.assertIn("QDM_SHELL_DIALECT_UNAVAILABLE", output[0].content[0].text)

    def test_cmd_dialect_is_rejected_when_not_allowed(self) -> None:
        provider = _Provider()
        executor = _Executor()
        tokens = _set_context(_requester())
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="cmd.exe"):
                output, calls = asyncio.run(_collect(
                    QdmShellHookMiddleware(provider, executor, allowed_dialects={"bash", "powershell"}),
                    _tool("qdm-metric-cli auth describe"),
                ))
        finally:
            _reset_context(tokens)
        self.assertEqual(calls, [])
        self.assertIn("QDM_SHELL_DIALECT_UNAVAILABLE", output[0].content[0].text)

    def test_shell_dialect_maps_windows_fallback_and_known_executables(self) -> None:
        with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value=None):
            with patch(f"{PACKAGE}.qdm_shell_hook.os.name", "nt"):
                self.assertEqual(shell_dialect(), "cmd")
        with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value=""):
            with patch(f"{PACKAGE}.qdm_shell_hook.os.name", "nt"):
                self.assertEqual(shell_dialect(), "cmd")
        with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="C:\\Windows\\System32\\cmd.exe"):
            self.assertEqual(shell_dialect(), "cmd")
        with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="PowerShell.EXE"):
            self.assertEqual(shell_dialect(), "powershell")
        with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="zsh"):
            self.assertIsNone(shell_dialect())
        with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value=None):
            with patch(f"{PACKAGE}.qdm_shell_hook.os.name", "posix"):
                self.assertIsNone(shell_dialect())

    def test_snapshot_is_reused_only_for_the_same_requester(self) -> None:
        requester = _requester()
        snapshot = types.SimpleNamespace(requester=requester, blob="qdm1enc.snapshot")
        provider = _Provider()
        executor = _Executor("trusted")
        tokens = _set_context(requester, snapshot)
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="cmd.exe"):
                _output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor, allowed_dialects={"cmd"}), _tool("qdm-metric-cli auth describe")))
        finally:
            _reset_context(tokens)
        self.assertEqual(calls, ["trusted"])
        self.assertEqual(provider.calls, 0)
        self.assertEqual(executor.calls[0]["blob"], "qdm1enc.snapshot")

    def test_runtime_and_adapter_calls_are_moved_to_threads(self) -> None:
        provider = _Provider()
        executor = _Executor("trusted")
        to_thread_calls: list[str] = []

        async def fake_to_thread(func: object, *args: object, **kwargs: object) -> object:
            to_thread_calls.append(getattr(func, "__name__", "unknown"))
            return func(*args, **kwargs)  # type: ignore[misc]

        tokens = _set_context(_requester())
        try:
            with patch("qwenpaw.config.context.get_current_shell_command_executable", return_value="/bin/bash"):
                with patch(f"{PACKAGE}.qdm_shell_hook.asyncio.to_thread", side_effect=fake_to_thread):
                    _output, calls = asyncio.run(_collect(QdmShellHookMiddleware(provider, executor), _tool("qdm-metric-cli auth describe")))
        finally:
            _reset_context(tokens)
        self.assertEqual(calls, ["trusted"])
        self.assertEqual(to_thread_calls, ["blob_for", "authorize_shell"])


class ShellAuthorizeBridgeTests(unittest.TestCase):
    def _executor(self, envelope: object) -> QdmCliExecutor:
        self.temp = tempfile.TemporaryDirectory()
        harness = Path(self.temp.name) / "data-harness-cli"
        harness.write_text("placeholder", encoding="utf-8")
        if os.name != "nt":
            harness.chmod(harness.stat().st_mode | stat.S_IXUSR)

        def fake_run(_argv: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess([], 0, json.dumps(envelope), "")

        self.run_patch = patch(f"{PACKAGE}.qdm_cli.subprocess.run", side_effect=fake_run)
        self.run_patch.start()
        return QdmCliExecutor(Path(self.temp.name) / "qdm-metric-cli", harness_cli=harness)

    def tearDown(self) -> None:
        patcher = getattr(self, "run_patch", None)
        if patcher is not None:
            patcher.stop()
        temp = getattr(self, "temp", None)
        if temp is not None:
            temp.cleanup()

    def test_authorize_shell_extracts_updated_input_from_allow_envelope(self) -> None:
        executor = self._executor({
            "schemaVersion": 1,
            "status": "allow",
            "hookOutput": {"permissionDecision": "allow", "updatedInput": {"command": "trusted"}},
        })
        self.assertEqual(executor.authorize_shell(dialect="bash", command="qdm-metric-cli auth describe", blob="qdm1enc.demo"), "trusted")

    def test_authorize_shell_extracts_nested_hook_specific_output(self) -> None:
        executor = self._executor({
            "schemaVersion": 1,
            "status": "allow",
            "hookOutput": {"hookSpecificOutput": {"permissionDecision": "allow", "updatedInput": {"command": "trusted"}}},
        })
        self.assertEqual(executor.authorize_shell(dialect="powershell", command="qdm-metric-cli auth describe", blob="qdm1enc.demo"), "trusted")

    def test_authorize_shell_noop_returns_none(self) -> None:
        executor = self._executor({"schemaVersion": 1, "status": "noop", "hookOutput": {}})
        self.assertIsNone(executor.authorize_shell(dialect="bash", command="echo qdm", blob="qdm1enc.demo"))

    def test_authorize_shell_deny_maps_stable_code(self) -> None:
        executor = self._executor({
            "schemaVersion": 1,
            "status": "deny",
            "hookOutput": {"permissionDecision": "deny", "permissionDecisionReason": "QDM_AUTH_CAPABILITY_DENIED: no"},
        })
        with self.assertRaisesRegex(QdmCliError, "QDM_AUTH_CAPABILITY_DENIED"):
            executor.authorize_shell(dialect="bash", command="qdm-metric-cli auth describe", blob="qdm1enc.demo")

    def test_authorize_shell_malformed_allow_is_rejected(self) -> None:
        executor = self._executor({
            "schemaVersion": 1,
            "status": "allow",
            "hookOutput": {"permissionDecision": "allow"},
        })
        with self.assertRaisesRegex(QdmCliError, "QDM_AUTHZ_PROTOCOL_INVALID"):
            executor.authorize_shell(dialect="bash", command="qdm-metric-cli auth describe", blob="qdm1enc.demo")

    def test_authorize_shell_rejects_missing_schema_version(self) -> None:
        executor = self._executor({
            "status": "allow",
            "hookOutput": {"permissionDecision": "allow", "updatedInput": {"command": "trusted"}},
        })
        with self.assertRaisesRegex(QdmCliError, "QDM_AUTHZ_PROTOCOL_INVALID"):
            executor.authorize_shell(dialect="bash", command="qdm-metric-cli auth describe", blob="qdm1enc.demo")


if __name__ == "__main__":
    unittest.main()
