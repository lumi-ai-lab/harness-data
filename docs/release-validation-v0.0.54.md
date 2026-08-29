# v0.0.54 正式发布验收（2026-08-29）

## 结论

`v0.0.54` 已完成正式发布闭环：不可变标签校验、完整测试、七宿主 artifact、Wikis、外部 CLI 加密附件、GitHub Release、multi-arch 容器、npm 发布和最终 npx smoke 全部通过。

- 标签提交：`31e2390f67efc4c0b580ec075ebb742fe5996231`
- 成功 Release run：`33269615760`，attempt 2
- npm：`@lumi-ai-lab/harness-data@0.0.54`，public，`latest: 0.0.54`
- npx smoke：输出 `installer 0.0.54`
- GHCR：`ghcr.io/lumi-ai-lab/harness-data-cli:v0.0.54`
- multi-arch index digest：`sha256:4c0bb66614469cde87908a9d4dbd7414c36cfd680a861a38959d178e9803d047`
- 平台：`linux/amd64`、`linux/arm64`

## GitHub Release 资产

| 资产 | SHA-256 | 结果 |
| --- | --- | --- |
| `harness-data-runtime-v0.0.54.zip` | `49445a82fdb608e6e13226ca8d538c7cae1b98d9e866de2cf10517f9b1ee8a33` | 已发布、可下载、解包后通过 runtime artifact 校验 |
| `harness-data-wikis-v0.0.54.zip` | `5d43f399eaffc0db98392a9f970cd5ba79f9eb4b1e82107e4241b6cb42c0173e` | 已发布、可下载、固定 Wikis 内容完整 |

ZIP 目录项按传统 ZIP 格式不加密；实际文件条目使用发布密码。workflow 同时用正确密码解包并用错误密码读取真实文件，错误密码被拒绝。

## 发布门槛发现并修复的问题

首次标签 run `33268849154` 在发布前正确阻断：当时最新的 `qdm-metric-cli v0.1.16` 四个平台 ZIP 是手工上传的未加密附件，违反既有加密发布契约，没有 Harness 资产、容器或 npm 包被发布。

上游修复：

- `qdm-metric-cli#59` 将版本测试从硬编码 `0.1.10` 改为解析 JSON 并校验当前 `version` 常量；
- 发布 `qdm-metric-cli v0.1.17`，run `33269491106` 通过；
- `darwin-arm64`、`linux-amd64`、`windows-amd64`、`windows-arm64` 四个 ZIP 均由正式 workflow 生成并确认 encrypted；
- 层级审计仍为硬门槛，诊断 artifact 上传在 GitHub 存储配额耗尽时改为非阻断。

第一次 workflow-dispatch 尝试在 Node test runner 的 worker 反序列化处出现一次性进程异常；同一提交的本地、PR、master 测试均已通过。原地 rerun 后 installer、JS CLI、七宿主 artifact、Wikis 和外部资产校验全部通过，随后完成正式发布。

## 成功 run 的关键 job

- Validate release tag：通过；
- Publish CLI release assets：通过；
- Verify release assets：通过；
- Publish CLI container：通过；
- Publish npm installer：通过；
- Verify npm release：通过。

## 尚未覆盖

- Codex 桌面客户端 reload 仍受自动化安全策略限制，需要人工确认；
- Codex 升级/回滚和生产 secret provider 仍属于 Phase 5 后续实机验收；
- GitHub Actions 已提示部分 action 的 Node.js 20 runtime 被强制升级到 Node.js 24，后续应升级相关 action 版本并消除 warning。
