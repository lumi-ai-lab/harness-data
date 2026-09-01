# Root Context v1 threat model

This is the Phase 0 security baseline for the split-root runtime. It records
the boundaries implemented by the current JS/Node adapters and the remaining
platform-specific work.

| Threat | Boundary / mitigation | Current status |
| --- | --- | --- |
| Plugin cache becomes a writable data disk | `pluginRoot` is validated separately; state/config helpers use `dataRoot`/`stateRoot` | Implemented for structured callers |
| Symlink redirects a root or secret | Existing roots are canonicalized with `realpath`; secret files reject final symlinks | Implemented |
| Path traversal escapes an owner root | `PathResolver.resolveOwned()` rejects absolute and `..` paths | Implemented |
| Auth blob appears in model-visible argv | File/`secretRef` sources pass a canonical file path on Unix; inline env blobs remain a compatibility path | Unix MVP; Windows needs a safe file/host handoff |
| Secret file is readable by another user | Existing secret files require regular-file semantics and mode `0600` on Unix | Implemented for JS/Node readers |
| Ordinary prompt creates durable state | Enabled-project structured hooks may inject bounded context; ordinary Codex prompts still do not write raw prompt or project `.harness` state, and structured state stores only a hash when persistence is required | Implemented for structured callers |
| Two hook processes overwrite one session | Structured state writes use a per-session lock, atomic rename, and stale-lock recovery | Basic lock implemented; conflict telemetry remains |
| Workspace identity collides across projects | State root derives from canonical workspace path, host, and schema version | Implemented |
| Invalid context silently falls back to cwd | Structured context errors surface stable `QDM_*` codes; legacy scanning is isolated behind compatibility APIs | Implemented in JS/Node entry points |
| Diagnostic output leaks prompt or secret content | Structured state stores a prompt hash; diagnostics contain sizes/metadata, not the raw prompt | Implemented for structured hooks |

Open items before production-wide rollout are Windows secret handoff/ACL
validation, host secret APIs, migration rollback evidence, and end-to-end
verification for every supported host.
