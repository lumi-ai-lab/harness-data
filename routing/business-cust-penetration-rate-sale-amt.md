---
id: routing-business-cust-penetration-rate-sale-amt
kind: routing
domain: business
title: 经营分析-销售额指标路由规则
tags:
  - routing
  - business-report
  - cust-penetration-rate
  - saleAmt
match:
  keywords:
    - 销售额
    - saleAmt
    - 销售额情况
    - 销售额为什么下降
    - 销售额为什么提升
---

# 经营分析-销售额指标路由规则

判断为销售额专项报告时，固定走 `qdm-cmr-cli report business`，固定 `--indicator 销售额`。

必要取数模块：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 销售额 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 销售额 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 销售额 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 销售额 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 销售额 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 销售额 --ai &
wait

bin/data-harness-cli inject-template
```

门禁规则：

- 六个必要模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 只有在 template 注入命令成功且后续收到 selected playbook 绑定的 template 二阶段注入后，才允许生成最终报告正文。
- template 注入后只注入 template 正文，不再注入 spec、routing 或 playbook。
- 禁止使用本地 demo 数据或静态示例值替代 CLI 返回值。
- 对 CLI 未返回的数据，不得自行估算。
- 不得路由到客数渗透率根指标、品效或活跃供应商数专项；泛经营问题继续走 `routing/business-overview.md`。
