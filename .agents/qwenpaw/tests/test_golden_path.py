"""QwenPaw plugin adaptation golden path (end-to-end contract anchor).

Runs the real harness-data setup and data-harness-cli processes together
with the real Python bridge modules against a stub qdm-metric-cli.  It
verifies the observable contract the P0 vertical slice must satisfy:

  1. ``setup --host qwenpaw`` builds a self-contained instanceRoot layout
     (wikis, index, config, runtime, manifests) and leaves the project
     directory free of Harness resources.
  2. Context injection embeds wiki manual content through the CLI; the
     Python bridge no longer reads wiki files itself.
  3. ``qdm_query`` succeeds without a Python-side ``auth describe``
     preflight (authorization is delegated to the JS CLI).
  4. The ``posttool --format qwenpaw-hook`` report protocol stays alive.
  5. Reinstalling the plugin (simulating ``plugin install --force``,
     which replaces the artifactRoot) preserves the instanceRoot.

The test is the refactoring anchor: it is RED today because the qwenpaw
setup layout, the ``context qwenpaw-hook`` format and the
``authz-hook --agent qwenpaw`` entry point do not exist yet.  It does not
require a QwenPaw runtime; the bridge modules are importable standalone.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
QWENPAW_SOURCE = ROOT / ".agents" / "qwenpaw"
INSTALLER_CLI = ROOT / "npm" / "bin" / "harness-data.js"
CLI_MAIN = ROOT / "packages" / "data-harness-cli" / "src" / "main.js"
AUTH_BLOB_FIXTURE = ROOT / "config" / "fixtures" / "local-test-auth.blob"
CLI_MANIFEST = ROOT / "bootstrap" / "cli-manifest.json"
QWENPAW_PLUGIN_JSON = QWENPAW_SOURCE / "plugin.json"

PACKAGE = "qdm_harness_qwenpaw_test"
if PACKAGE not in sys.modules:
    package = types.ModuleType(PACKAGE)
    package.__path__ = [str(QWENPAW_SOURCE)]
    sys.modules[PACKAGE] = package

from qdm_harness_qwenpaw_test.qdm_cli import QdmCliExecutor  # noqa: E402
from qdm_harness_qwenpaw_test.qdm_harness_context import HarnessContextError, request_context  # noqa: E402

WIKI_SPEC = """---
name: "metric_sale_amt"
label: "销售额"
aliases:
  - saleAmt
---

# 销售额

销售额是门店销售商品的总金额。
"""

WIKI_PLAYBOOK = """---
name: "playbook_metric_sale_amt"
label: "销售额取数手册"
---

# 销售额取数手册

用户询问销售额时使用本手册, 通过 qdm_query 查询 metric=saleAmt。
"""


class _Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.plugin_root = root / "plugin-root"
        self.instance = root / "instance"
        self.data = root / "data"
        self.project = root / "project"
        self.wikis = root / "wikis"
        self.secrets = root / "secrets"
        self.auth_blob = root / "auth.blob"
        self.metric_cli = root / "qdm-metric-cli"
        self.shim = self.plugin_root / "scripts" / "data-harness-cli"
        self.stub_log = root / "stub.log"
        self.env: dict[str, str] = {}

    def build(self) -> None:
        for directory in (
            self.plugin_root / "bootstrap",
            self.plugin_root / "scripts",
            self.instance,
            self.data,
            self.project,
            self.secrets,
        ):
            directory.mkdir(parents=True, exist_ok=True)
        self._seed_wikis()
        shutil.copyfile(CLI_MANIFEST, self.plugin_root / "bootstrap" / "cli-manifest.json")
        shutil.copyfile(QWENPAW_PLUGIN_JSON, self.plugin_root / "plugin.json")
        for package in ("data-harness-cli", "harness-runtime-node", "html-report-kernel"):
            self._vendor_package(package)
        self._write_shim()
        self._write_metric_stub()
        shutil.copyfile(AUTH_BLOB_FIXTURE, self.auth_blob)
        if os.name != "nt":
            self.auth_blob.chmod(0o600)
        self.env = {
            "HARNESS_HOST": "qwenpaw",
            "HARNESS_PLUGIN_ROOT": str(self.plugin_root),
            "HARNESS_RESOURCE_ROOT": str(self.instance),
            "HARNESS_DATA_ROOT": str(self.data),
            "HARNESS_WORKSPACE_ROOT": str(self.project),
            "HARNESS_SECRET_ROOT": str(self.secrets),
            "HARNESS_CONTEXT_FILE": str(self.instance / "context.json"),
            "QDM_HARNESS_HOOK_MODE": "auto-context",
            "STUB_LOG": str(self.stub_log),
            "QDM_AUTH_USER_ID": "local-test-user",
        }

    def _vendor_package(self, name: str) -> None:
        source = ROOT / "packages" / name
        target = self.plugin_root / "vendor" / name
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("node_modules", "test", "tests"))

    def _seed_wikis(self) -> None:
        for name in ("metrics", "reports", "dims", "rules"):
            (self.wikis / name).mkdir(parents=True, exist_ok=True)
        (self.wikis / "index.md").write_text("# index\n", encoding="utf-8")
        metric_dir = self.wikis / "metrics" / "销售额"
        metric_dir.mkdir(parents=True, exist_ok=True)
        (metric_dir / "spec.md").write_text(WIKI_SPEC, encoding="utf-8")
        (metric_dir / "playbook.md").write_text(WIKI_PLAYBOOK, encoding="utf-8")

    def _write_shim(self) -> None:
        self.shim.write_text(
            "#!/usr/bin/env node\n"
            f"import {{ main }} from {json.dumps(str(CLI_MAIN))};\n"
            "await main();\n",
            encoding="utf-8",
        )
        if os.name != "nt":
            self.shim.chmod(0o755)

    def _write_metric_stub(self) -> None:
        self.metric_cli.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "log = os.environ.get('STUB_LOG', '/tmp/stub-metric.log')\n"
            "with open(log, 'a') as f:\n"
            "    f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'auth':\n"
            "    print(json.dumps({'enabled': True, 'capabilities': ['qdm.metric.query'],\n"
            "                      'labelsResolved': True,\n"
            "                      'dataScope': {'manageAreaId': [{'id': 'CN01', 'name': '华南区'}]}}))\n"
            "else:\n"
            "    print(json.dumps({'rows': [{'metric': 'saleAmt', 'value': 123.4}]}))\n",
            encoding="utf-8",
        )
        if os.name != "nt":
            self.metric_cli.chmod(0o755)

    def reinstall_plugin(self) -> None:
        """Simulate ``qwenpaw plugin install --force`` replacing artifactRoot."""
        shutil.rmtree(self.plugin_root)
        self.plugin_root.mkdir(parents=True)
        (self.plugin_root / "bootstrap").mkdir()
        (self.plugin_root / "scripts").mkdir()
        shutil.copyfile(CLI_MANIFEST, self.plugin_root / "bootstrap" / "cli-manifest.json")
        shutil.copyfile(QWENPAW_PLUGIN_JSON, self.plugin_root / "plugin.json")
        for package in ("data-harness-cli", "harness-runtime-node", "html-report-kernel"):
            self._vendor_package(package)
        self._write_shim()

    def instance_snapshot(self) -> dict[str, str]:
        snapshot: dict[str, str] = {}
        for entry in sorted(self.instance.rglob("*")):
            if entry.is_file():
                snapshot[str(entry.relative_to(self.instance))] = entry.read_bytes().hex()
        return snapshot


def _run_setup(fixture: _Fixture) -> subprocess.CompletedProcess[str]:
    args = [
        str(INSTALLER_CLI), "setup",
        "--host", "qwenpaw",
        "--plugin-root", str(fixture.plugin_root),
        "--resource-root", str(fixture.instance),
        "--data-root", str(fixture.data),
        "--workspace-root", str(fixture.project),
        "--workspace-allowlist", str(fixture.project),
        "--wikis-source", str(fixture.wikis),
        "--metric-cli", str(fixture.metric_cli),
        "--auth-blob-file", str(fixture.auth_blob),
        "--auth-user-id", "local-test-user",
        "--json",
    ]
    env = {key: value for key, value in os.environ.items() if key != "HARNESS_CONTEXT_FILE"}
    env.update(fixture.env)
    env.pop("HARNESS_CONTEXT_FILE", None)
    return subprocess.run(args, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)


def _run_cli(fixture: _Fixture, *args: str, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(fixture.shim), *args],
        input=input_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        env={**os.environ, **fixture.env},
    )


class GoldenPathTests(unittest.TestCase):
    maxDiff: int | None = None

    def setUp(self) -> None:
        temp = Path(tempfile.mkdtemp(prefix="qdm-qwenpaw-golden-"))
        self.addCleanup(shutil.rmtree, temp, ignore_errors=True)
        self.fixture = _Fixture(temp)
        self.fixture.build()
        self._preserved_env = dict(os.environ)
        os.environ.update(self.fixture.env)
        self.addCleanup(self._restore_env)
        result = _run_setup(self.fixture)
        if result.returncode != 0:
            self.fail(f"setup --host qwenpaw failed (rc={result.returncode}):\n{result.stdout}\n{result.stderr}")
        if not (self.fixture.instance / "context.json").is_file():
            self.fail(
                "setup --host qwenpaw did not create instanceRoot/context.json; "
                "the legacy dataRoot-owned layout is still in use",
            )

    def _restore_env(self) -> None:
        os.environ.clear()
        os.environ.update(self._preserved_env)

    def test_setup_builds_self_contained_instance_layout(self) -> None:
        instance = self.fixture.instance
        self.assertTrue((instance / "resources" / "wikis" / "index.md").is_file())
        self.assertTrue((instance / "resources" / "wikis" / "metrics" / "销售额" / "playbook.md").is_file())
        self.assertTrue((instance / ".harness" / "index" / "wikis-index.json").is_file())
        self.assertTrue((instance / "config" / "harness-config.yaml").is_file())
        self.assertTrue((instance / "config" / "settings.json").is_file())
        self.assertTrue((instance / "config" / "workspace-policy.json").is_file())
        self.assertTrue((instance / "context.json").is_file())
        self.assertTrue((instance / "install-manifest.json").is_file())
        runtimes = list((instance / "runtimes").glob("*/qdm-metric-cli")) if (instance / "runtimes").is_dir() else []
        self.assertEqual(len(runtimes), 1, f"qdm-metric-cli runtime missing under {instance / 'runtimes'}")
        self.assertFalse((self.fixture.data / "wikis").exists(), "wikis must not land in dataRoot")
        for forbidden in ("wikis", ".harness", "bin", "config"):
            self.assertFalse(
                (self.fixture.project / forbidden).exists(),
                f"project directory must stay free of Harness resources: {forbidden}",
            )

    def test_context_embeds_wiki_manuals_through_cli(self) -> None:
        content = request_context(self.fixture.shim, "qwenpaw:" + "a" * 64, "销售额是多少", timeout_seconds=60)
        self.assertIn("销售额取数手册", content)
        self.assertIn("saleAmt", content)

    def test_qdm_query_delegates_authorization_to_cli(self) -> None:
        executor = QdmCliExecutor(self.fixture.metric_cli)
        result = executor.query(
            metric="saleAmt",
            start_date="2026-08-24",
            end_date="2026-08-24",
            filters={"manageAreaId": ["CN01"]},
            blob="qdm1enc.trusted",
        )
        self.assertIn("123.4", result)
        calls = self.fixture.stub_log.read_text(encoding="utf-8").splitlines()
        commands = [json.loads(line)[0] for line in calls if line.strip()]
        self.assertNotIn("auth", commands, "Python bridge must not run qdm-metric-cli auth describe")

    def test_report_lifecycle_protocol_stays_available(self) -> None:
        payload = json.dumps({
            "session_id": "qwenpaw:" + "b" * 64,
            "tool_name": "qdm_query",
            "status": "success",
            "safe_command_args": {"report_name": "financial-overview", "report_module": "indicators"},
        })
        result = _run_cli(self.fixture, "posttool", "--format", "qwenpaw-hook", input_text=payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertIn("diagnostic_code", output)

    def test_reinstall_preserves_instance_root(self) -> None:
        before = self.fixture.instance_snapshot()
        self.fixture.reinstall_plugin()
        after = self.fixture.instance_snapshot()
        self.assertEqual(after, before, "replacing the plugin must not touch the instanceRoot")


if __name__ == "__main__":
    unittest.main()
