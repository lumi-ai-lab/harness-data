---
id: routing-business-active-vender-num-active-vender-num
kind: routing
domain: business
title: 经营分析-活跃供应商数指标路由规则
tags:
  - routing
  - business-report
  - active-vender-num
  - activeVenderNum
match:
  keywords:
    - 活跃供应商数
    - activeVenderNum
    - 活跃供应商数情况
    - 活跃供应商数为什么下降
    - 活跃供应商数为什么提升
---

# 经营分析-活跃供应商数指标路由规则

判断为活跃供应商数专项报告时，固定走 `qdm-cmr-cli report business`，固定 `--indicator 活跃供应商数`。

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 活跃供应商数 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 活跃供应商数 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 活跃供应商数 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 活跃供应商数 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 活跃供应商数 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 活跃供应商数 --ai &
wait

bin/data-harness-cli inject-template
```

门禁规则：

- 六个必要模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 禁止使用本地 demo 数据或静态示例值替代 CLI 返回值。
- 对 CLI 未返回的数据，不得自行估算。
- 不得路由到集采入库占比、三率综合得分、准确率、准点率、合格率、品效或客数渗透率专项；泛经营问题继续走 `routing/business-overview.md`。
