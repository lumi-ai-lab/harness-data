---
id: routing-business-cust-penetration-rate-bf19-sale-weight
kind: routing
domain: business
title: 经营分析-19点前销售重量指标路由规则
tags:
  - routing
  - cust-penetration-rate
  - bf19SaleWeight
match:
  keywords:
    - 19点前销售重量
    - bf19SaleWeight
    - 19点前销售重量情况
    - 19点前销售重量为什么下降
    - 19点前销售重量为什么提升
---

# 经营分析-19点前销售重量指标路由规则

判断为19点前销售重量专项报告时，固定走 `qdm-cmr-cli report business`，固定 `--indicator 19点前销售重量`。

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 19点前销售重量 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 19点前销售重量 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 19点前销售重量 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 19点前销售重量 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 19点前销售重量 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 19点前销售重量 --ai &
wait

bin/data-harness-cli inject-template
```

门禁规则：

- 六个必要模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 禁止使用本地 demo 数据或静态示例值替代 CLI 返回值。
- 对 CLI 未返回的数据，不得自行估算。
- 不得路由到销售额、19点前销售占比、订单满足率、客数、客单价或毛利专项；泛经营问题继续走 `routing/business-overview.md`。
