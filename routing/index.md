---
id: routing-index
kind: routing
domain: common
title: 路由导航
tags:
  - routing
  - index
match:
  keywords:
    - 路由
    - report
---

# QDM CLI 路由索引

Hook 只负责召回相关上下文文件，不预先决定单一 report 类型。Agent 读取本轮召回的 routing 文件后，再根据用户问题、spec 和 playbook 判断实际取数路径。

| report intent | signal name | routing file |
|---|---|---|
| 经营分析 | `business-overview` | `routing/business-overview.md` |
| 门店管理 | `store-overview` | `routing/store-overview.md` |
| 用户运营 | `member-overview` | `routing/member-overview.md` |
| 财务核心指标 | `financial-overview` | `routing/financial-overview.md` |

公共约束：

- CLI 绝对路径集中配置在当前项目的 `config/qdm-cli-paths.env`。
- 必须使用 `$QDM_CMR_CLI`，不得使用本地静态示例值替代 CLI 返回值。
- 必需取数完成后，下一步必须立即执行 `before-report-signal.py <report_name>`；signal 前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 最终报告必须等 `before-report-signal.py <report_name>` 成功，并收到该 report 的 template 二阶段注入后再输出；signal 后只注入匹配的 template 正文，不再注入 spec、routing 或 playbook；template 在 signal 前不读取、不使用。
