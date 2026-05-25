---
id: routing-business-cust-penetration-rate-bf19-cust-num
kind: routing
domain: business
title: 经营分析-19点前客数指标路由规则
tags:
  - routing
  - business-report
  - cust-penetration-rate
  - bf19CustNum
match:
  keywords:
    - 19点前客数
    - bf19CustNum
    - 19点前客数情况
    - 19点前客数为什么下降
    - 19点前客数为什么提升
---

# 经营分析-19点前客数指标路由规则

判断为 19点前客数专项报告时，固定走 `qdm-cmr-cli report business`，固定 `--indicator 19点前客数`。

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 19点前客数 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 19点前客数 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 19点前客数 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 19点前客数 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 19点前客数 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 19点前客数 --ai &
wait

bin/data-harness-cli inject-template
```

门禁规则：

- 六个必要模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 禁止使用本地 demo 数据或静态示例值替代 CLI 返回值。
- 不得路由到客数、客数渗透率、19点前PI值、19点前复购率、销售额、品效或活跃供应商数专项；泛经营问题继续走 `routing/business-overview.md`。
