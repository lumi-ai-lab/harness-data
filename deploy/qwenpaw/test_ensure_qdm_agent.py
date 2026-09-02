"""Unit tests for the QDM agent bootstrap decisions.

Run with: python3 -m unittest discover -s deploy/qwenpaw -p 'test_*.py'
These cover the pure planning/mutation helpers only; creating an agent and
writing config.json are exercised against a real QwenPaw working dir.
"""

from __future__ import annotations

import importlib.util
import os
import sys
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


if __name__ == "__main__":
    unittest.main()
