# Local data-auth fixtures

这些文件只用于本地开发和自动化测试，不代表生产用户身份。

| 文件 | 用途 |
| --- | --- |
| `local-test-auth.blob` | 加密的 `qdm1enc...` 测试授权材料 |
| `local-test-auth.json` | 重新生成测试 Blob 的明文配方 |

## 身份和范围

- `userId` 固定为 `local-test-user`；
- 不要把个人 CAS、企业微信或运营账号写入 fixture；
- Blob 中的声明只用于测试 QDM 数据权限结构；
- 任何能够取得该 Blob 的人都可能在接受该测试密钥的环境中使用测试主体。

## 在 Codex Plugin 中使用

Plugin 开发初始化或 Setup 可以直接指定 fixture：

```bash
node "$PLUGIN_ROOT/scripts/setup.mjs" \
  --auth-blob-file "$REPO_ROOT/config/fixtures/local-test-auth.blob" \
  --auth-user-id local-test-user \
  --metric-cli /path/to/qdm-metric-cli \
  --workspace-allowlist "$PWD"
```

Setup 会把它复制到：

```text
<pluginRoot>/secrets/auth.blob
```

复制后的文件应使用 `0600` 权限。不要提交 Setup 生成的文件。

## 重新生成 Blob

需要 `qdm-metric-cli` 源码仓库和对应的加密密钥：

```bash
cd /path/to/qdm-metric-cli
go run ./scripts/auth_blob_encrypt.go \
  -in /path/to/harness-data/config/fixtures/local-test-auth.json \
  > /path/to/harness-data/config/fixtures/local-test-auth.blob
```

除非同步修改测试配置，否则保持 `userId` 为 `local-test-user`。不要复制个人授权材料替换共享 fixture。
