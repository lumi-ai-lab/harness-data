"""Unit tests for the image-managed skill seeding decisions.

Run with: python3 -m unittest discover -s deploy/qwenpaw -p 'test_*.py'
These cover the seeding set and the fail-closed paths; ``skill.json`` mutation
happens through the QwenPaw internal API, which is stubbed here.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path


HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("seed_image_skills", os.path.join(HERE, "seed_image_skills.py"))
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def _fake_qwenpaw(enabled: list[tuple[str, str]]) -> None:
    """Install a stub of the QwenPaw skill API used by the seeding loop."""
    registry = types.ModuleType("qwenpaw.agents.skill_system.registry")
    workspace_service = types.ModuleType("qwenpaw.agents.skill_system.workspace_service")

    class SkillService:
        def __init__(self, workspace: Path) -> None:
            self.workspace = workspace

        def enable_skill(self, name: str) -> dict[str, object]:
            enabled.append((self.workspace.name, name))
            return {"success": True, "updated_workspaces": [self.workspace.name]}

    registry.reconcile_workspace_manifest = lambda workspace: None
    workspace_service.SkillService = SkillService

    modules = {
        "qwenpaw": types.ModuleType("qwenpaw"),
        "qwenpaw.agents": types.ModuleType("qwenpaw.agents"),
        "qwenpaw.agents.skill_system": types.ModuleType("qwenpaw.agents.skill_system"),
        "qwenpaw.agents.skill_system.registry": registry,
        "qwenpaw.agents.skill_system.workspace_service": workspace_service,
    }
    sys.modules.update(modules)


class SkillsForAgentTests(unittest.TestCase):
    def test_shared_default_agent_never_gets_the_qdm_skill(self) -> None:
        self.assertEqual(MODULE.skills_for_agent("default", Path("/app/working")), MODULE.IMAGE_SKILLS)
        self.assertNotIn(MODULE.QDM_SKILL, MODULE.skills_for_agent("default", Path("/app/working")))

    def test_qdm_agents_get_the_qdm_skill_from_the_plugin_install_dir(self) -> None:
        skills = MODULE.skills_for_agent("harness-data-default", Path("/app/working"))
        self.assertEqual(set(skills) - set(MODULE.IMAGE_SKILLS), {MODULE.QDM_SKILL})
        self.assertEqual(
            skills[MODULE.QDM_SKILL],
            "/app/working/plugins/qdm-harness-qwenpaw/skills/qdm-harness",
        )


class SeedRunTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_image_skills = dict(MODULE.IMAGE_SKILLS)
        self._saved_modules = {k: sys.modules.get(k) for k in (
            "qwenpaw", "qwenpaw.agents", "qwenpaw.agents.skill_system",
            "qwenpaw.agents.skill_system.registry",
            "qwenpaw.agents.skill_system.workspace_service",
        )}
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        working = root / "working"
        sources = root / "image"
        for name in MODULE.IMAGE_SKILLS:
            (sources / name).mkdir(parents=True)
            (sources / name / "SKILL.md").write_text(f"# {name}\n", encoding="utf-8")
        plugin_skill = working / "plugins" / MODULE.PLUGIN_ID / "skills" / MODULE.QDM_SKILL
        plugin_skill.mkdir(parents=True)
        (plugin_skill / "SKILL.md").write_text("# qdm-harness\n", encoding="utf-8")
        MODULE.IMAGE_SKILLS.clear()
        MODULE.IMAGE_SKILLS.update({name: str(sources / name) for name in self._saved_image_skills})

        self.working = working
        workspaces: dict[str, str] = {}
        for agent_id in ("default", "harness-data-default", "QwenPaw_QA_Agent_0.2"):
            workspace = working / "workspaces" / agent_id
            workspace.mkdir(parents=True)
            workspaces[agent_id] = str(workspace)
        (working / "config.json").write_text(
            json.dumps({"agents": {"profiles": {
                agent_id: {"workspace_dir": path} for agent_id, path in workspaces.items()
            }}}),
            encoding="utf-8",
        )
        self._env = {"QWENPAW_WORKING_DIR": str(working)}
        for key, value in self._env.items():
            os.environ[key] = value
        self.addCleanup(lambda: [os.environ.pop(k, None) for k in self._env])
        self.enabled: list[tuple[str, str]] = []
        _fake_qwenpaw(self.enabled)

    def tearDown(self) -> None:
        MODULE.IMAGE_SKILLS.clear()
        MODULE.IMAGE_SKILLS.update(self._saved_image_skills)
        for name, module in self._saved_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def test_qdm_skill_lands_only_on_the_qdm_agent_and_every_copy_is_enabled(self) -> None:
        self.assertEqual(MODULE.main(), 0)

        default_skills = sorted(p.name for p in (self.working / "workspaces/default/skills").iterdir())
        qdm_skills = sorted(p.name for p in (self.working / "workspaces/harness-data-default/skills").iterdir())
        self.assertEqual(default_skills, sorted(MODULE.IMAGE_SKILLS))
        self.assertEqual(qdm_skills, sorted({*MODULE.IMAGE_SKILLS, MODULE.QDM_SKILL}))
        self.assertFalse((self.working / "workspaces/QwenPaw_QA_Agent_0.2/skills").exists())

        self.assertEqual(
            sorted(self.enabled),
            sorted(
                [(agent, name) for name in MODULE.IMAGE_SKILLS for agent in ("default", "harness-data-default")]
                + [("harness-data-default", MODULE.QDM_SKILL)]
            ),
        )

    def test_a_replaced_target_keeps_the_image_content(self) -> None:
        stale = self.working / "workspaces/harness-data-default/skills/charts-cli"
        stale.mkdir(parents=True)
        (stale / "stale.md").write_text("from an older image\n", encoding="utf-8")
        # entrypoint 把插件目录 chmod -R a-w，落地后的只读树也必须能被下次启动替换
        os.chmod(stale, 0o555)

        self.assertEqual(MODULE.main(), 0)
        self.assertFalse((stale / "stale.md").exists())
        self.assertTrue((stale / "SKILL.md").is_file())
        os.chmod(stale, 0o755)
        shutil.rmtree(stale)

    def test_a_missing_qdm_source_fails_closed(self) -> None:
        shutil.rmtree(self.working / "plugins" / MODULE.PLUGIN_ID / "skills" / MODULE.QDM_SKILL)
        self.assertEqual(MODULE.main(), 78)
        # 来源缺失在动手播种之前就被检出: 任何 agent 的 skill.json 都不该被改
        self.assertEqual(self.enabled, [])
        self.assertFalse(
            (self.working / "workspaces/harness-data-default/skills" / MODULE.QDM_SKILL).exists()
        )


if __name__ == "__main__":
    unittest.main()
