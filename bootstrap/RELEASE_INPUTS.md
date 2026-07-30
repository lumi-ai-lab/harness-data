# Lumi release approval inputs

The repository intentionally does not contain placeholder approval data. A
Lumi release is blocked until the business/data-governance owners provide all
of these paths:

- `bootstrap/approved-indicators-v1.json`
- `bootstrap/approved-lumi-wikis/`
- `bootstrap/approved-lumi-wikis-manifest.json`

The indicator catalog must satisfy the strict
`data-harness-cli authz-validate-catalog` contract for the frozen Indicators
CLI v0.0.4 grammar.

The Wikis manifest uses this exact schema:

```json
{
  "version": 1,
  "files": [
    { "path": "relative/path.md", "sha256": "64-lowercase-hex" }
  ]
}
```

Entries must be sorted by path, may not include symlinks or Git metadata, and
must exactly enumerate the approved source tree. The approved tree must contain
`index.md` plus approved files under `metrics/`, `reports/`, `dims/`, and
`rules/`. Extra, missing, or modified files fail materialization, installation,
and doctor checks.

These files are approval inputs, not generated defaults. Do not create an empty
or sample catalog/content set merely to make a release pass.

The runtime bundle also ships `bootstrap/authz-config-v1.schema.json`. Deployment
owners use that versioned schema when producing the root-owned runtime mount at
`/etc/harness-data/authz.json`; the schema contains no approval values or secrets,
and `data-harness-cli authz-readiness` remains the authoritative runtime check.
