# Harness Data npm installer

```bash
npx @lumi-ai-lab/harness-data install
npx @lumi-ai-lab/harness-data install --git-protocol ssh
npx @lumi-ai-lab/harness-data install --git-protocol https
GITHUB_TOKEN=... npx @lumi-ai-lab/harness-data install --yes --agent codex --git-protocol https --github-token-env GITHUB_TOKEN --cas-config-dir /secure/path/to/cas
npx @lumi-ai-lab/harness-data install --yes --agent pi --cas-config-dir /secure/path/to/cas
npx @lumi-ai-lab/harness-data doctor --dir ~/harness-data
npx @lumi-ai-lab/harness-data update --dir ~/harness-data
```

This package is only the installer and updater. The full Harness Data workspace is cloned and maintained outside the npm package.

Private GitHub repository access defaults to `--git-protocol auto`: SSH is tried first, then HTTPS. HTTPS uses Git Credential Manager, `gh auth login`, or a token supplied through `--github-token-env`; GitHub account passwords are not supported.

The `qdm-cmr-cli`, `qdm-indicators-cli`, and `cas-cli` binaries are downloaded from private GitHub Releases in `pengmide/qdm-cmr-cli`, `pengmide/qdm-indicators-cli`, and `pengmide/qdm-cas-cli`. The installer uses `gh auth login` first and falls back to `--github-token-env`.

`--agent` supports `claude`, `codex`, `pi`, `both` (Claude + Codex), and `all` (Claude + Codex + Pi).
