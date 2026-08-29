# Codex Phase 5 版本切换与持久性历史记录

记录日期：2026-08-29

> 历史归档。本文包含旧 runtime artifact 验证命令，不代表当前用户安装或发布方式。当前 Codex Plugin 布局见 [`codex-plugin-layout.md`](codex-plugin-layout.md)。

## 验收范围

本次使用真实 Codex CLI `0.150.1` 和隔离的临时 marketplace，验证：

- `0.0.54 → 0.0.55-test → 0.0.54` 插件版本切换；
- install/enablement、MCP 缓存目录和插件 self-test；
- 显式 `dataRoot`、workspace identity、metric-cli、file `secretRef` 和报告 session 在切换后的持久性；
- `setup`/`doctor` 对当前插件版本的识别；
- 桌面客户端 reload 和宿主原生 secret API 的实际能力边界。

测试只使用仓库内的本地 auth fixture。没有读取、记录或输出生产 secret。

## 产物构建

分别构建 `0.0.54` 和 `0.0.55-test` runtime artifact：

```bash
scripts/build-runtime-artifact.sh --output-dir <tempRoot>/runtime-0.0.54 --version 0.0.54
scripts/build-runtime-artifact.sh --output-dir <tempRoot>/runtime-0.0.55-test --version 0.0.55-test
```

两套产物均满足：

- runtime artifact 校验通过；
- html-report MCP self-test 为 `10/10 passed`；
- `.codex-plugin/plugin.json` 与 `plugin-manifest.json` 的版本一致；
- Codex marketplace 插件包含 `bootstrap/cli-manifest.json`。

## 真实 Codex CLI 切换结果

通过 `codex plugin remove`、`codex plugin marketplace remove/add` 和 `codex plugin add` 执行真实切换。

| 阶段 | plugin list | MCP cwd | self-test | doctor |
| --- | --- | --- | --- | --- |
| 基线 `0.0.54` | installed + enabled | `.../harness-data/0.0.54` | 10/10 | PASS |
| 升级 `0.0.55-test` | installed + enabled | `.../harness-data/0.0.55-test` | 10/10 | PASS |
| 回滚 `0.0.54` | installed + enabled | `.../harness-data/0.0.54` | 10/10 | PASS |

升级和回滚后，`doctor --json` 均识别当前 native plugin 版本，而不是沿用上一次 setup 写入的旧版本。

## dataRoot、secret 与 session 持久性

隔离环境使用独立的 `dataRoot`、`secretRoot` 和仓库 workspace：

- setup 将现有 metric-cli 复制到 `dataRoot/runtimes/darwin-arm64/qdm-metric-cli`，状态为 `ready`；
- file `secretRef` 位于独立 `secretRoot`，Unix 权限为 `0600`；
- `paths`/`doctor` 只公开 `secretRef.kind=file`，没有输出文件内容；
- 插件升级和回滚后，install manifest、metric-cli、secret reference 和 workspace identity 均保持可用；
- 在 `0.0.55-test` 下创建的 `A_CONFIG` report session，在回滚到 `0.0.54` 后仍可通过同一 `stateRoot` 和 session ID 读取，`currentStage` 保持 `A_CONFIG`。

回滚后再次执行幂等 setup，install manifest 已恢复记录 `pluginVersion: 0.0.54`，metric-cli 仍为 `ready`，secret 仍为 `configured`。

## 验收中修复的问题

1. host artifact 构建此前只改写 Claude 原生 manifest，Codex 原生 manifest 仍保留源码版本。
2. runtime artifact 的 Codex native manifest 和产品 manifest 未绑定构建版本。
3. Codex marketplace 插件缺少 `bootstrap/cli-manifest.json`，导致真实缓存目录下 doctor 的 runtime manifest 检查失败。
4. setup 和 doctor 优先使用旧 install manifest 的 plugin version，导致升级后仍报告旧版本。

上述问题均已增加自动化回归。

## 尚未完成的宿主证据

- Computer Use 对 `com.openai.codex` 返回安全策略拒绝，因此无法自动执行桌面客户端 reload/new-session；不能用 CLI smoke 替代该证据。
- 当前仓库和 Codex CLI 可见接口没有可调用的宿主原生 secret provider。已验证的是外部 `0600` file `secretRef`；host-native secret API 仍为 unavailable/unverified。

因此 P5-02 仍不标记为全部完成。版本切换、显式 dataRoot、workspace/file-secret handoff、报告 session 恢复和 CLI 生命周期证据已经完成；剩余门槛仅为桌面客户端人工 reload/new-session，以及宿主原生 secret provider 的产品决策或实际接入。

## 自动化验证

```bash
node --test \
  scripts/host-artifact.test.mjs \
  scripts/build-runtime-artifact.test.mjs \
  scripts/verify-artifact.test.mjs \
  npm/test/golden-path.test.js
```

结果：25 pass，0 fail。
