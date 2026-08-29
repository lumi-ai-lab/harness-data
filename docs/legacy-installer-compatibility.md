# 旧 installer 兼容与迁移政策

> 决策日期：2026-08-29
> 基线版本：`0.0.53`

## 决策

`install --dir <runtime-dir>` 继续作为旧 runtime 的兼容入口，不作为新插件的默认安装模型。新插件不得把旧 runtime 或宿主插件缓存推断为新的 `pluginRoot`、`dataRoot` 或 `workspaceRoot`。

兼容窗口按发布版本冻结如下：

| 版本 | 行为 |
| --- | --- |
| `0.0.53` | 旧模型基线；继续支持 `install --dir`、`update` 和 legacy doctor。 |
| 首个包含 `qdm-harness migrate` 的版本（计划为 `0.0.54`） | 保留完整旧入口；新插件仅提示用户先运行 `migrate --check`，不得静默复用旧目录。 |
| 紧随迁移首发版的一个正式 patch 版本（计划为 `0.0.55`） | 继续保留完整旧入口和迁移入口，修复迁移兼容问题。 |
| 不早于其后的版本（最早计划为 `0.0.56`） | 只有满足本文件的停止支持门槛后，才可移除旧 installer 入口。 |

如果迁移首发版本不是 `0.0.54`，后续版本号应整体顺延；“迁移首发版 + 一个正式 patch 版本”的窗口不变。发布说明必须写出实际起止版本和迁移入口。

## 兼容期行为

- `install --dir`、旧 `update` 和旧 runtime 的 doctor 继续可用。
- 新插件发现有效旧 runtime 时只输出可执行的迁移提示；不会自动复制、移动或覆盖 auth、state、报告或 runtime。
- `qdm-harness migrate --check --from <old-runtime>` 必须只读，并在正式迁移前给出计划、风险和阻塞项。
- 正式迁移使用 copy + 校验 + pointer/manifest；失败时旧 runtime、旧数据和旧 hook 保持可用。
- auth 只能迁移为显式 `secretRef` 或受限 `secretRoot` 文件；不得写入插件包、`dataRoot`，也不得出现在日志或模型可见命令中。

## 停止支持门槛

在移除旧入口前，必须全部满足：

1. macOS、Linux、Windows 都有可复核的迁移 fixture；
2. 成功、坏版本、权限失败和重复迁移的测试通过，且失败不破坏旧 runtime；
3. `doctor --json` 能验证迁移后的根、资源、runtime 和 secret reference；
4. 至少一个完整发布周期没有阻塞性迁移或回滚回归；
5. 文档、doctor、错误码、迁移指引和 support runbook 已更新；
6. 对用户公开最后支持版本、停止支持版本与可回滚路径。

未满足任一门槛时，兼容窗口自动延长，不得以日期或计划版本强制删除旧入口。

## 实施映射

- 迁移命令与只读检查：Phase 4 `P4-02`、`P4-03`。
- 旧数据安全映射、回滚和幂等：`P4-04` 至 `P4-11`。
- 删除旧 installer 的最终门槛：Phase 6 `P6-01` 至 `P6-07`。
