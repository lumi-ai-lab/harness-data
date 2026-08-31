# Pi Phase 5 验收记录

记录日期：2026-08-29

## 已完成的本机证据

- Pi CLI 版本为 `0.84.3`。
- 使用隔离的 `PI_CODING_AGENT_DIR` 和 `PI_OFFLINE=1` clean profile 执行本地插件安装：
  `pi install /Users/pengmd/c/qdm/wt-harness-data-js-cli/plugins/pi-html-report`。
- `pi list` 正确发现并登记 `@lumi-ai-lab/pi-html-report` 本地包。
- 随后执行 `pi remove /Users/pengmd/c/qdm/wt-harness-data-js-cli/plugins/pi-html-report`，`pi list` 返回 `No packages installed.`。
- Pi artifact 的 `build`、`verify`、`self-test` 已通过；构建产物保持相对路径并包含 extension、skills、subagents 和 vendor core。
- Pi extension/authz 回归已在 macOS 临时目录权限修正后通过：`.agents/pi/extensions/qdm-harness/test/*.test.mjs` 共 80 pass；fixture 现在显式写入并再次校验 auth 文件 `0600`，不放宽生产权限约束。

## 当前阻塞

- 当前 clean profile 没有任何 provider API key，非交互 prompt 在模型调用前退出，尚不能证明真实 session/reload 或报告流程。
- 尚未验证 Pi 的 workspace handoff、生产 secret provider、升级/回滚和 session 恢复。

因此本记录不把 Pi 标记为 Phase 5 完成；后续需在具备可用 provider 的隔离 profile 中补齐真实会话证据。
