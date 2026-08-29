# Codex golden path 实施记录

> 记录日期：2026-08-29

本文把首个 golden-path 宿主固定为 Codex，并记录当前采用的 Root Context 映射、边界和验收证据。它是实施基线，不替代后续真实 Codex 实机 smoke。

## 实施决策

| 决策 | 当前采用方案 |
| --- | --- |
| 首个宿主 | Codex |
| `pluginRoot` | 安装后的 runtime/plugin 目录，只读处理，可被版本目录替换 |
| `dataRoot` | 优先 `HARNESS_DATA_ROOT`，其次 `CODEX_HOME`，否则使用 OS data 目录 |
| `secretRoot` | 独立于 plugin/data/workspace 的 OS 目录 |
| `secretRef` | 优先外部 file reference（Unix 要求 regular file + `0600`）；host/fd 仅保留协议位 |
| `workspaceRoot` | 优先 `HARNESS_WORKSPACE_ROOT`/`CODEX_WORKSPACE_ROOT`，或由 Codex hook envelope 的 `cwd` 明确传入 |
| `stateRoot` | 有 workspace 时由 `dataRoot/state/workspaces/<workspaceIdentity>` 派生 |
| hook 模式 | structured context 默认 on-demand；普通 prompt 不注入 wiki、不创建 durable state |
| 无 workspace | `paths`/`doctor`/只读 context 可用；report、template、session 写操作返回 `QDM_WORKSPACE_REQUIRED` |
| 报告位置 | 用户明确要求导出时写入 workspace 下的 `analysis/main.md`；session/job 状态留在 `stateRoot` |
| legacy 兼容 | 保留 `install --dir` 与旧 workspace 诊断，迁移命令完成前不删除 |

## 命令契约

```text
qdm-harness setup --context-file <context.json>
qdm-harness paths --context-file <context.json> --json
qdm-harness doctor --context-file <context.json> --json
```

`setup` 只写 `dataRoot`/`secretRoot`，生成非敏感 `config/settings.json` 和 `install-manifest.json`，不会创建用户项目 `.harness`。`doctor` 和 `paths` 只读，不写 diagnostics 或 state。

## Codex capability matrix（当前证据）

| Host | workspace | data | secret | session | hook/reload | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | envelope/env | `CODEX_HOME`/显式 root | file `0600`/reference | `session_id` | hooks + shim；reload 待实机 | `npm/test/golden-path.test.js`、`packages/data-harness-cli/test/root-context.test.js` |
| Claude | 待实机 | 待确认 | 待确认 | 待确认 | 待确认 | Phase 5 |
| WorkBuddy | 已有 adapter | 待确认 | macOS/Windows adapter | 已有 runner | 已有 hook | `.agents/workbuddy/scripts/*` |
| Pi | 待复核 | npm artifact | 待确认 | clean profile | build/verify/test | `plugins/pi-html-report/test/*` |
| OpenClaw | 待实机 | 待确认 | 待确认 | 待确认 | 待确认 | Phase 5 |
| Hermes | 待实机 | 待确认 | 待确认 | 待确认 | 待确认 | Phase 5 |
| QwenPaw | adapter 已存在 | 待确认 | Python adapter | 待确认 | hook 已存在 | `.agents/qwenpaw/*` |

## 最小验收矩阵

| 场景 | 当前状态 | 证据 |
| --- | --- | --- |
| setup 幂等 | 已通过 | `npm/test/golden-path.test.js` |
| 五根 paths JSON | 已通过 | `npm/test/golden-path.test.js` |
| doctor JSON 脱敏 | 已通过 | `collectRootDoctor` + golden-path test |
| hook envelope → context | 已通过单元验证 | `packages/data-harness-cli/test/root-context.test.js` |
| 缺 workspace 写入 fail-closed | 已通过单元验证 | `packages/data-harness-cli/test/root-context.test.js` |
| pluginRoot 只读完整链路 | 待 clean-room | Phase 2/P3 |
| explicit report E2E | 待接入 Codex fixture | Phase 2 |
| reload/new-session 恢复 | 待验证 | Phase 2 |
| artifact relocation/audit | 待验证 | Phase 3 |

## Clean-room fixture 布局

```text
fixture-root/
  plugin/       # runtime/pluginRoot，只读模拟
  data/         # CODEX_HOME/dataRoot，可写
  secrets/      # secretRoot，0600 file
  workspace/    # workspaceRoot，可写
  context.json  # host=codex 的结构化 context
```

测试使用本地 executable fixture 代替网络下载，真实发布链路仍需在随机安装目录复核。
