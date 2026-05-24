# QDM CLI 路由索引

Hook 已在 UserPromptSubmit 阶段完成确定性路由。Agent 不需要阅读所有候选路由，只读取本轮命中的单一 report 路由文件。

| query_type | report_name | routing file |
|---|---|---|
| `business_overview` | `business-overview` | `routing/business-overview.md` |
| `store_overview` | `store-overview` | `routing/store-overview.md` |
| `member_overview` | `member-overview` | `routing/member-overview.md` |
| `financial_overview` | `financial-overview` | `routing/financial-overview.md` |

公共约束：

- CLI 绝对路径集中配置在当前项目的 `config/qdm-cli-paths.env`。
- 必须使用 `$QDM_CMR_CLI`，不得使用本地静态示例值替代 CLI 返回值。
- 必需取数完成后，下一步必须立即执行 `before-report-signal.py <report_name>`；signal 前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 最终报告必须等 `before-report-signal.py <report_name>` 成功，并收到该 report 的 template 二阶段注入后再输出；该 report 的 spec 已在取数前注入，template 在 signal 前不读取、不使用。
