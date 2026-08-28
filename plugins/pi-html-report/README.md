# @lumi-ai-lab/pi-html-report

PI plugin for the html-report pipeline. It ships the qdm-harness Extension, html-report Skills, and four report agents. Deterministic fetch/caption/compose logic comes from the bundled Kernel.

## Prerequisite

The workspace must already be a Harness Data runtime (`npx @lumi-ai-lab/harness-data install`): Node, `qdm-metric-cli`, `config/harness-config.yaml`, authz, and wikis.

## Install

```bash
pi install npm:@lumi-ai-lab/pi-html-report
```

Restart Pi so Extension and agent discovery reload. Then `html-report` should see:

- qdm-harness
- html-report / html-report-design skills
- `qdm-html-report.report-writer` / `report-researcher` / `report-reviewer` / `report-designer`

Uninstalling the plugin unregisters Extension / Skill / Agents. It does not delete runtime, config, auth, wikis, or sessions.
