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
| legacy 兼容 | `0.0.53` 为旧模型基线；迁移首发版及其后一个正式 patch 版本保留 `install --dir`，其后仅在迁移/回滚门槛满足时移除。详见 [`legacy-installer-compatibility.md`](legacy-installer-compatibility.md) |

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
| pluginRoot 只读完整链路 | 已通过自动化 clean-room | `npm/test/golden-path.test.js` |
| explicit report E2E | 已通过离线可复核 fixture | `result.json` → session 副本 → workspace `analysis/main.md` |
| reload/new-session 恢复 | 已通过跨进程与插件替换模拟；Codex UI 实机仍留给 Phase 5 | `npm/test/golden-path.test.js` |
| artifact relocation/audit | 已完成静态审计；真实 release archive 随机安装 smoke 待 Phase 3 后续 | `scripts/verify-artifact.mjs` |

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

## 自动化验收补充（2026-08-29）

- clean-room 测试把完整 Codex runtime 复制到随机目录，并以只读 `pluginRoot`、可写 `dataRoot`、独立 `secretRoot` 和 workspace 运行 `setup`、`paths`、`doctor`、report 与实际 Codex hook command；全过程校验插件目录内容不变。
- report E2E 以 confirmed `result.json`、可校验的卡片数据和 caption 为输入，通过独立 Node 进程推进到 `B2_MAIN`；session 中保留可恢复的 `analysis/main.md`，用户可见副本原子写入 `<workspaceRoot>/analysis/main.md`。
- 同一测试以 v2 插件目录重新启动，验证既有 auth reference、下载 runtime、报告 session 保持可用，并能创建新 session。该证据验证进程/目录替换语义，不等同于真实 Codex 客户端 UI 的 reload 操作。
