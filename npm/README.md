# Harness Data npm installer

## Prerequisites

- **Node.js 18+**
- **Git** (on PATH)
- **tar** (on PATH; bundled with Git for Windows on Windows)
- **Windows only** — additional requirements:
  - **unzip** — not bundled with Git for Windows by default. Install via MSYS2 (`pacman -S unzip`) or copy from an MSYS2 installation into a PATH directory. The installer checks for `unzip` and will stop with `missing required command: unzip` if it is absent.
  - **Codex Agent only** — Windows supports Codex exclusively; other agents (Claude, Pi, OpenClaw, Hermes) are not available on Windows.
  - **Windows x64 + ARM64** are both supported.

Install a Harness Data runtime in the current directory:

```bash
npx @lumi-ai-lab/harness-data install
```

Install into an explicit runtime directory:

```bash
npx @lumi-ai-lab/harness-data install --dir /path/to/runtime
```

Use a GitHub token for private Release assets:

```bash
npx @lumi-ai-lab/harness-data install --github-token ...
```

or:

```bash
GITHUB_TOKEN=... npx @lumi-ai-lab/harness-data install
```

Enable metric **data-auth** (authz) during install — writes `authz.mode: on`, copies the local-test encrypted blob, and keeps Host `_auth` as the preferred source when present:

```bash
GITHUB_TOKEN=... npx @lumi-ai-lab/harness-data install --data-auth
```

Without Lumi/Host, the shipped `config/fixtures/local-test-auth.blob` is used as fallback (`dev_user_id: local-test-user`).

Without a GitHub token, the installer interactively asks for a local absolute path to `qdm-metric-cli` and `harness-data-wikis`. Data queries use only `qdm-metric-cli` (`qdm-cmr-cli` / `qdm-indicators-cli` / `qdm-sql-cli` / `cas-cli` are no longer installed).

Update an existing runtime interactively:

```bash
npx @lumi-ai-lab/harness-data update
```

Diagnose a runtime:

```bash
npx @lumi-ai-lab/harness-data doctor
```

The runtime is assembled from the `harness-data` runtime bundle, platform-specific CLI Release assets (`data-harness-cli`, `qdm-metric-cli`), `harness-data-wikis`, generated local config, and selected Agent symlinks.

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `both`, and `all`; the default is `all`. `both` installs Claude + Codex, while `all` installs Claude + Codex + Pi + OpenClaw + Hermes. On Windows, only `codex` is available and is auto-selected.
