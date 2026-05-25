---
id: routing-business-brand-product-effectiveness-lost-rate
kind: routing
domain: business
title: 经营分析-损耗率指标路由规则
tags:
  - routing
  - business-report
  - brand-product-effectiveness
  - lostRate
match:
  keywords:
    - 损耗率
    - lostRate
    - 损耗率情况
    - 损耗率为什么下降
    - 损耗率为什么提升
---

# 经营分析-损耗率指标路由规则

判断为损耗率专项报告时，固定走 `qdm-cmr-cli report business`，固定 `--indicator 损耗率`。

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 损耗率 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 损耗率 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 损耗率 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 损耗率 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 损耗率 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 损耗率 --ai &
wait

bin/data-harness-cli inject-template
```

门禁规则：

- 六个必要模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 禁止使用本地 demo 数据或静态示例值替代 CLI 返回值。
- 对 CLI 未返回的数据，不得自行估算。
- 不得路由到品效、定价毛利率、预期毛利率、出库折让率、时段折扣率、促销折扣率、商品订购渗透率或售价价格指数专项；泛经营问题继续走 `routing/business-overview.md`。
