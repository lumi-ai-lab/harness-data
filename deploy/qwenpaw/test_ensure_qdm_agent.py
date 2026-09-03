"""Unit tests for the QDM agent bootstrap decisions.

Run with: python3 -m unittest discover -s deploy/qwenpaw -p 'test_*.py'
These cover the pure planning/mutation helpers only; creating an agent and
writing config.json are exercised against a real QwenPaw working dir.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from types import SimpleNamespace


HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("ensure_qdm_agent", os.path.join(HERE, "ensure_qdm_agent.py"))
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def _channels(**names: bool) -> SimpleNamespace:
    return SimpleNamespace(**{name: SimpleNamespace(enabled=flag) for name, flag in names.items()})


class ChannelMovePlanTests(unittest.TestCase):
    def test_only_a_source_enabled_channel_moves(self) -> None:
        moveable, conflicting = MODULE.plan_channel_moves(
            _channels(wecom=True, feishu=False), _channels(wecom=False, feishu=False),
        )
        self.assertEqual(moveable, ["wecom"])
        self.assertEqual(conflicting, [])

    def test_a_channel_enabled_on_both_sides_is_reported_not_touched(self) -> None:
        source = _channels(wecom=True)
        target = _channels(wecom=True)
        moveable, conflicting = MODULE.plan_channel_moves(source, target)
        self.assertEqual(moveable, [])
        self.assertEqual(conflicting, ["wecom"])
        self.assertTrue(source.wecom.enabled and target.wecom.enabled)

    def test_console_and_unrelated_channels_are_never_candidates(self) -> None:
        moveable, conflicting = MODULE.plan_channel_moves(
            _channels(console=True, wechat=True, qq=True), _channels(console=False),
        )
        self.assertEqual((moveable, conflicting), ([], []))

    def test_a_missing_channel_block_is_not_an_error(self) -> None:
        self.assertEqual(MODULE.plan_channel_moves(SimpleNamespace(), SimpleNamespace()), ([], []))
        self.assertEqual(MODULE.plan_channel_moves(None, None), ([], []))
        self.assertFalse(MODULE.channel_enabled(None, "wecom"))


class ChannelMoveApplyTests(unittest.TestCase):
    def test_move_carries_credentials_and_disables_the_source(self) -> None:
        source = _channels(wecom=False)
        source.wecom.bot_id = "ww-secret-123"
        target = _channels(wecom=False)
        MODULE.apply_channel_moves(source, target, ["wecom"])
        self.assertTrue(target.wecom.enabled, "the moved channel must be enabled on the new agent")
        self.assertEqual(target.wecom.bot_id, "ww-secret-123")
        self.assertFalse(source.wecom.enabled, "the old agent must stop connecting")

    def test_the_moved_config_is_a_copy_not_a_shared_reference(self) -> None:
        source = _channels(feishu=True)
        source.feishu.app_id = "cli-1"
        target = _channels(feishu=False)
        MODULE.apply_channel_moves(source, target, ["feishu"])
        target.feishu.app_id = "changed"
        self.assertEqual(source.feishu.app_id, "cli-1", "the moved config must be a deep copy")
        self.assertFalse(source.feishu.enabled)
        self.assertTrue(target.feishu.enabled)

class AgentIdContractTests(unittest.TestCase):
    def test_the_default_agent_id_matches_the_plugin_scope_convention(self) -> None:
        self.assertTrue(MODULE.DEFAULT_QDM_AGENT_ID.startswith("harness-data-"))

    def test_reusing_the_hosts_shared_agent_is_refused(self) -> None:
        previous = os.environ.get("QWENPAW_QDM_AGENT_ID")
        os.environ["QWENPAW_QDM_AGENT_ID"] = MODULE.LEGACY_SHARED_AGENT_ID
        try:
            # The guard must fire before any host import, so a misconfiguration
            # reports itself instead of surfacing as an ImportError.
            with self.assertRaisesRegex(RuntimeError, "shared default agent"):
                MODULE.ensure()
        finally:
            if previous is None:
                del os.environ["QWENPAW_QDM_AGENT_ID"]
            else:
                os.environ["QWENPAW_QDM_AGENT_ID"] = previous


class ToolPolicyTests(unittest.TestCase):
    """apply_strict_tool_policy 的纯文件级行为, 与插件 _configure_allowlist 对齐。"""

    def _write_agent(self, tools: dict | None = None, extra: dict | None = None, mode: int = 0o600) -> str:
        path = tempfile.NamedTemporaryFile(prefix="agent-test-", suffix=".json", delete=False)
        path.close()
        data: dict = {"id": "harness-data-default", "name": "QDM 数据助手"}
        if tools is not None:
            data["tools"] = {"builtin_tools": tools}
        if extra:
            data.update(extra)
        os.chmod(path.name, mode)
        with open(path.name, "w", encoding="utf-8") as handle:
            # 与模块内序列化格式一致(indent=2 + 结尾换行), 干净的收窄态才能逐字节命中
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        return path.name

    def _read(self, path: str) -> dict:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    def test_strict_policy_disables_host_tools_and_keeps_the_allowlist(self) -> None:
        path = self._write_agent({
            "qdm_query": {"name": "qdm_query", "enabled": True},
            "qdm_scope_summary": {"name": "qdm_scope_summary", "enabled": True},
            "get_current_time": {"name": "get_current_time", "enabled": True},
            "read_file": {"name": "read_file", "enabled": True},
            "web_search": {"name": "web_search", "enabled": True},
        })
        try:
            self.assertTrue(MODULE.apply_strict_tool_policy(path))
            tools = self._read(path)["tools"]["builtin_tools"]
            self.assertTrue(tools["qdm_query"]["enabled"])
            self.assertTrue(tools["qdm_scope_summary"]["enabled"])
            self.assertTrue(tools["get_current_time"]["enabled"])
            self.assertFalse(tools["read_file"]["enabled"])
            self.assertFalse(tools["web_search"]["enabled"])
        finally:
            os.unlink(path)

    def test_strict_policy_is_idempotent_and_does_not_rewrite_when_clean(self) -> None:
        path = self._write_agent({
            "qdm_query": {"name": "qdm_query", "enabled": True},
            "qdm_scope_summary": {"name": "qdm_scope_summary", "enabled": True},
            "get_current_time": {"name": "get_current_time", "enabled": True},
            "read_file": {"name": "read_file", "enabled": False},
        }, extra={"light_context_config": {"tool_result_pruning_config": {"enabled": False}}})
        try:
            with open(path, encoding="utf-8") as handle:
                before = handle.read()
            self.assertFalse(MODULE.apply_strict_tool_policy(path), "已是收窄状态就不该重写")
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), before, "无改动时必须保持文件原样")
        finally:
            os.unlink(path)

    def test_strict_policy_preserves_other_config_and_file_mode(self) -> None:
        channels = {"channels": {"wecom": {"enabled": True}, "console": {"enabled": True}}}
        path = self._write_agent({
            "qdm_query": {"name": "qdm_query", "enabled": True},
            "execute_shell_command": {"name": "execute_shell_command", "enabled": True},
        }, extra=channels, mode=0o640)
        try:
            self.assertTrue(MODULE.apply_strict_tool_policy(path))
            data = self._read(path)
            self.assertEqual(data["channels"], channels["channels"], "收窄不能动渠道配置")
            self.assertEqual(os.stat(path).st_mode & 0o7777, 0o640, "必须保留原文件权限位")
        finally:
            os.unlink(path)

    def test_strict_policy_turns_off_tool_result_pruning(self) -> None:
        path = self._write_agent({"qdm_query": {"name": "qdm_query", "enabled": True}})
        try:
            self.assertTrue(MODULE.apply_strict_tool_policy(path))
            pruning = self._read(path)["light_context_config"]["tool_result_pruning_config"]
            self.assertIs(pruning["enabled"], False)
        finally:
            os.unlink(path)

    def test_an_entry_without_enabled_reads_as_enabled_and_is_disabled(self) -> None:
        path = self._write_agent({
            "read_file": {"name": "read_file"},
            "qdm_query": {"name": "qdm_query"},
        })
        try:
            self.assertTrue(MODULE.apply_strict_tool_policy(path))
            tools = self._read(path)["tools"]["builtin_tools"]
            self.assertFalse(tools["read_file"]["enabled"], "缺省 enabled 视作启用, 必须被关掉")
            self.assertTrue(tools["qdm_query"]["enabled"])
        finally:
            os.unlink(path)

    def test_strict_policy_tolerates_a_missing_tools_section(self) -> None:
        path = self._write_agent(extra={"active_model": {"provider_id": "qdm-market"}})
        try:
            self.assertTrue(MODULE.apply_strict_tool_policy(path))
            data = self._read(path)
            self.assertIs(data["light_context_config"]["tool_result_pruning_config"]["enabled"], False)
            self.assertEqual(data["tools"]["builtin_tools"], {})
            self.assertEqual(data["active_model"]["provider_id"], "qdm-market")
        finally:
            os.unlink(path)

    def test_the_allowlist_is_exactly_the_qdm_trio(self) -> None:
        self.assertEqual(set(MODULE.STRICT_ALLOWED_TOOLS), {"qdm_query", "qdm_scope_summary", "get_current_time"})


if __name__ == "__main__":
    unittest.main()
