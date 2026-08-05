# Local data-auth fixtures

Shared **local-only** metric data-auth materials for Harness when Host `_auth` is not available (for example no Lumi upstream yet).

| File | Purpose |
| --- | --- |
| `local-test-auth.blob` | Encrypted `qdm1enc...` blob (committed, shipped in runtime bundle) |
| `local-test-auth.json` | Plaintext recipe used to regenerate the blob |

## Identity & scope

- **`userId`**: always `local-test-user` (must match `authz.dev_user_id` / slot user)
- **Do not** put personal CAS / WeCom userIds (e.g. real operator accounts) into this fixture
- **Authorization claims** mirror the shape used by [qdm-metric-cli `test/auth.json`](https://github.com/lumi-ai-lab/qdm-metric-cli) (capability + `qdm.scope`), with a generic test principal instead of a real person
- Scope sample: `manageAreaIds` / `dcManageAreaIds` = `CN01`, `categoryLevel1Ids` = `10`, `11`
- Capability: `qdm.metric.query`

**Not a production identity.** Anyone with the blob can present as this test principal against backends that accept the shared metric-cli blob key.

## Installer / switch

```bash
npx @lumi-ai-lab/harness-data install --data-auth
# or local PI manual test:
bash config/authz-manual-test/switch.sh on
```

Copies `local-test-auth.blob` → `config/dev-auth.blob` (gitignored working copy) and writes:

```yaml
authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: local-test-user
  allow_local_blob: true
```

Host `_auth` still wins when present.

## Regenerate blob

Requires [qdm-metric-cli](https://github.com/lumi-ai-lab/qdm-metric-cli) and the same encryption key the CLI embeds (or `QDM_METRIC_AUTH_BLOB_KEY`):

```bash
cd /path/to/qdm-metric-cli
go run ./scripts/auth_blob_encrypt.go \
  -in /path/to/harness-data/config/fixtures/local-test-auth.json \
  > /path/to/harness-data/config/fixtures/local-test-auth.blob
# refresh working copy used by switch.sh
cp /path/to/harness-data/config/fixtures/local-test-auth.blob \
   /path/to/harness-data/config/dev-auth.blob
```

Keep `userId` as `local-test-user` unless you also change `authz.dev_user_id` in installer defaults and `switch.sh`.
When updating scope, prefer aligning claims with metric-cli’s local test auth JSON, then re-encrypt — never copy a personal `userId`.
