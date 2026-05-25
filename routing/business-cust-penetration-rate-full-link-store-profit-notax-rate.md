---
id: routing-business-cust-penetration-rate-full-link-store-profit-notax-rate
kind: routing
domain: business
title: 经营分析-全链路毛利率指标路由规则
tags:
  - routing
  - business-report
  - cust-penetration-rate
  - fullLinkStoreProfitNotaxRate
match:
  keywords:
    - 全链路毛利率
    - fullLinkStoreProfitNotaxRate
    - 全链路毛利率情况
    - 全链路毛利率为什么下降
    - 全链路毛利率为什么提升
---

# 经营分析-全链路毛利率指标路由规则

判断为全链路毛利率专项报告时，固定走 `qdm-cmr-cli report business`，固定 `--indicator 全链路毛利率`。

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 全链路毛利率 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 全链路毛利率 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 全链路毛利率 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 全链路毛利率 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 全链路毛利率 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 全链路毛利率 --ai &
wait

bin/data-harness-cli inject-template
```

门禁规则：

- 六个必要模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 禁止使用本地 demo 数据或静态示例值替代 CLI 返回值。
- 对 CLI 未返回的数据，不得自行估算。
- 不得路由到门店毛利率、供应链毛利率、全链路毛利额、销售额、客数、客单价、品效或活跃供应商数专项；泛经营问题继续走 `routing/business-overview.md`。
