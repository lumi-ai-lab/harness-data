# Root Context v1

Root Context v1 separates the host-managed plugin files from durable product
data, secrets, and the active user workspace. New plugin adapters must pass a
validated context; implicit `process.cwd()` discovery is only a legacy-runtime
compatibility path.

```json
{
  "schemaVersion": 1,
  "host": "codex",
  "pluginRoot": "/absolute/path/to/plugin",
  "resourceRoot": "/absolute/path/to/data",
  "dataRoot": "/absolute/path/to/data",
  "secretRoot": "/absolute/path/to/secrets",
  "workspaceRoot": "/absolute/path/to/workspace",
  "stateRoot": "/absolute/path/to/data/state/workspaces/<workspace-id>",
  "configPath": "/absolute/path/to/data/config/settings.json",
  "secretRef": { "kind": "file", "path": "/absolute/path/to/secrets/auth.blob" },
  "sessionId": "host-session-id",
  "capabilities": {
    "canWriteWorkspace": true,
    "canWriteData": true,
    "hasStableSessionId": true,
    "supportsSecretReference": true
  }
}
```

Rules:

- `pluginRoot` and `dataRoot` are required absolute paths. `pluginRoot` must
  already be an existing directory; `dataRoot` may be created later by setup.
- `resourceRoot` owns Wikis and indexes. Plugin setup persists it explicitly;
  the first Plugin-only layout uses `resourceRoot = dataRoot`.
- Existing paths are canonicalized with `realpath`; nested or equal primary
  roots (`pluginRoot`, `dataRoot`, `secretRoot`, `workspaceRoot`) are rejected.
- `stateRoot` and `configPath` must be below `dataRoot`. If `stateRoot` is
  absent, it is derived from the canonical workspace path, host, and schema
  version using SHA-256.
- A file `secretRef` must be below `secretRoot`; it may not silently live in
  `dataRoot`.
- Existing secret files are regular, non-symlink files and must be mode `0600`
  on Unix-like systems.
- A structured `secretRef` may also use `{ "kind": "fd", "fd": N }` for an
  inherited secret descriptor. The Node runtime validates the encrypted blob
  from that descriptor without creating a secret file under `pluginRoot` or
  `dataRoot`; host adapters remain responsible for opening and passing the FD.
- Explicit CLI values override the context file, which overrides compatibility
  environment variables. If structured context is present but invalid, the CLI
  fails closed and does not fall back to its legacy root finder.
- `--context-file`, `--plugin-root`, `--resource-root`, `--data-root`, `--workspace-root`,
  `--state-root`, `--config`, `--secret-ref`, and `--session-id` are global CLI
  options. They may appear before or after the command (before `--`).

The current implementation exposes `data-harness-cli … paths --json` for
adapter diagnostics and `qdm-harness setup|paths|doctor|report` for the host
golden path. Structured Plugin setup routes wiki resources through explicit
`resourceRoot` (currently equal to `dataRoot`), mutable configuration/runtime through `dataRoot`, and session writes through
`stateRoot`; legacy string-root calls remain available only for compatibility.

Stable validation codes implemented in v1 are:

- `QDM_CONTEXT_INVALID`
- `QDM_PLUGIN_ROOT_UNAVAILABLE`
- `QDM_DATA_ROOT_UNAVAILABLE`
- `QDM_WORKSPACE_REQUIRED`
- `QDM_STATE_LOCKED`
- `QDM_RESOURCE_MISMATCH`
- `QDM_SECRET_UNAVAILABLE`
- `QDM_SETUP_REQUIRED`
- `QDM_MIGRATION_REQUIRED`
