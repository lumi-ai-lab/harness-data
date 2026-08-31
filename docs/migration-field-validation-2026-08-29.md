# 旧 Runtime 迁移现场验证（2026-08-29）

## 结论

使用本机真实 `0.0.53` Harness runtime 和真实历史 session 完成迁移现场验证：

- `migrate --check` 通过；
- 正式迁移通过，迁移后的 `doctor` 通过；
- 第二次迁移为幂等 no-op；
- 真实 business-report session 可从新 `stateRoot` 读取；
- 真实 html-report session 可在新 `stateRoot` 中执行 `status`、`resume` 和 `pause`；
- 旧 runtime 的 CLI、metric CLI 和 Git 工作树保持不变。

## 样本与保护措施

- 源 runtime：`/Users/pengmd/c/qdm/harness-data`
- npm 版本：`0.0.53`
- 源提交：`d13f462c8ed9f928986d3432d9dfe1ab821d74fe`
- 源授权模式：`off`
- metric CLI：`qdm-metric-cli 0.1.10`

原 runtime 只读使用。迁移输入来自临时快照：

- 排除 `.git/`、`node_modules/`、`dist/` 和 `config/dev-auth.blob`；
- 将旧 runtime 中的 metric CLI symlink 物化为快照内普通可执行文件；
- dataRoot、workspaceRoot 和 Codex host artifact 全部位于独立临时目录；
- 迁移前后比较源 runtime 的 `git status --porcelain`，结果一致。

## 验证对象

### Business report

- session：`01a0476a-f1a5-748c-b3a4-21f1c0717ba9`
- mode：`multi_single`
- 迁移后通过生产 `sessionstate.load()` 读取；
- 恢复出 4 个 selected playbooks。

### HTML report

- session：`01a047c1-eec0-7a52-9b8a-3afb1c0eaf0d`
- adapter contract：`0.0.46`
- 初始状态：`paused / A_CONFIG`
- `resume` 后：`running / A_CONFIG`
- 再次 `pause` 后：`paused / A_CONFIG`
- 最终 `pipeline-state.json.sessionDir` 指向迁移后的新 `stateRoot`，不再指向旧 runtime。

## 现场发现并修复的问题

1. 迁移器只接受带 `agents/` 的旧式 pluginRoot，无法绑定新 host artifact。
   - 修复：支持 `plugin-manifest.json + adapter/ + bootstrap manifest` 的新 artifact 身份，同时保留旧 runtime 校验。
2. 迁移器只接受 `agents/`，无法识别真实旧 runtime 使用的 `.agents/`。
   - 修复：兼容 `agents/` 和 `.agents/`，两者仍执行 symlink fail-closed 校验。
3. html-report 同时存在空壳哈希目录和可恢复旧目录时，runner 错误选择哈希目录。
   - 修复：按 `result.json` 或 `debug/pipeline-state.json` 可恢复标记选择目录。
4. 复制后的 `pipeline-state.json.sessionDir` 保留旧绝对路径。
   - 修复：迁移时确定性改写为最终 session 目录，并在迁移记录中分别保存源树身份和重写后的目标树摘要。

## 尚未覆盖

- 本次真实样本的 authz 为 `off`，不构成生产 secret provider 的实机验收；secretRef/0600 仍由现有自动化覆盖。
- Windows 的目录 symlink/junction 权限能力仍有 3 个明确 skip，三平台主迁移路径均为 0 fail。
- 正式 release 内容与 installer 解包一致性仍需主仓 PR 合并后的 master/release 流程证明。
