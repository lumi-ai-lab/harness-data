# Wikis 命令剩余待办

## 1. 修正召回值冲突检查

- [ ] `check-aliases` 的全局召回值冲突检查必须覆盖 `name`、`label`、`aliases`。
- [ ] 普通 spec 的 `name`、`label`、`aliases`，`c-` spec 已维护的召回字段，以及组合 playbook 的 `aliases` 之间，只要任意召回值重复，都应报 `duplicate_recall_value`。
- [ ] 当前实现不要跳过 `name` 和 `label` 的冲突检查。

## 2. 补齐跨 domain 组合 playbook 选择规则

- [ ] 多个普通 spec 命中时，如果没有直接命中组合 playbook，应继续查找 `covers` 能完整覆盖全部命中 spec 的组合 playbook。
- [ ] 多个候选都完整覆盖时，优先选择 `covers` 数量最少的组合 playbook。
- [ ] 如果 `covers` 数量仍并列，应支持按命中 spec 的共同上级 domain 选择更接近的组合 playbook。
- [ ] 当前实现只处理完全相同 domain 的优先级，需要补齐共同上级 domain 逻辑。
- [ ] 如果仍无法唯一选择，应保持进入 `free` 模式，不自动选择部分覆盖或不确定的组合 playbook。

## 3. 完善 `--fail-fast` 语义

- [ ] `check-all --fail-fast` 继续保持按既定顺序执行，在第一个失败检查项后停止。
- [ ] 单项 `wikis check-* --fail-fast` 应在发现第一条 error 后立即停止，而不是完整扫描后只截断输出。
- [ ] 确认 `--fail-fast` 下 exit code 仍符合约定：发现 error 返回 `1`，参数或运行时异常返回 `2`。

## 4. 统一检查命令 JSON 输出结构

- [ ] 单个 `wikis check-* --json` 和 `wikis check-all --json` 的 JSON 输出结构应保持一致。
- [ ] 输出中应稳定包含整体 `ok`、`totalErrors`、`results` 等顶层字段。
- [ ] 单项检查命令的 `results` 可以只包含一个 check result。
- [ ] 保留每个 check result 内的 `check`、`ok`、`totalErrors`、`shownErrors`、`hiddenErrors`、`truncated`、`errors` 字段。

## 5. 清理 routing 残留

- [ ] `config/harness-config.yaml` 不再把 `routing` 作为新 Wiki 主链路配置项。
- [ ] `README.md` 删除或更新仍描述 `wikis/routing` 作为 Agent 取数路由规则的内容。
- [ ] 清理旧索引残留，例如 `.harness/index/routing-index.json`。
- [ ] 确认运行时 context、索引和检查流程不依赖 routing。
