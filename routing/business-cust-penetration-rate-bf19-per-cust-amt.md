---
id: routing-business-cust-penetration-rate-bf19-per-cust-amt
kind: routing
domain: business
title: 经营分析-19点前客单价指标路由规则
tags:
  - routing
  - business-report
  - cust-penetration-rate
  - bf19PerCustAmt
match:
  keywords:
    - 19点前客单价
    - bf19PerCustAmt
    - 19点前客单价情况
    - 19点前客单价为什么下降
    - 19点前客单价为什么提升
---

# 经营分析-19点前客单价指标路由规则

判断为 19点前客单价专项报告时，固定走 `qdm-cmr-cli report business`，固定 `--indicator 19点前客单价`。

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 19点前客单价 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 19点前客单价 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 19点前客单价 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 19点前客单价 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 19点前客单价 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 19点前客单价 --ai &
wait

bin/data-harness-cli inject-template
```

门禁规则：

- 六个必要模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 禁止使用本地 demo 数据或静态示例值替代 CLI 返回值。
- 不得路由到客单价、19点前单均件数、19点前件单价、销售额、客数、品效或活跃供应商数专项；泛经营问题继续走 `routing/business-overview.md`。
