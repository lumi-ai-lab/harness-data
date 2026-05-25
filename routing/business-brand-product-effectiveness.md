---
id: routing-business-brand-product-effectiveness
kind: routing
domain: business
title: 经营分析-品效下钻路由规则
tags:
  - routing
  - business-report
  - brand-product-effectiveness
match:
  keywords:
    - 品效
    - 品效情况
    - 品效下钻
    - brandProductEffectiveness
    - 商品经营效率
---

# 经营分析-品效下钻路由规则

判断为品效下钻时，仍走 `qdm-cmr-cli report business`，固定 `--indicator 品效`。

CMR CLI 参数格式、时间过滤、`--ai` 白名单和失败重试规则以 `spec/common/cmr-cli-readme.md` 与 `spec/common/time-policy.md` 为准。

必要取数模块：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 品效 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 品效 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 品效 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 品效 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 品效 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 品效 --ai &
wait

bin/data-harness-cli inject-template
```

门禁规则：

- 六个必要模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 只有在 template 注入命令成功且后续收到 selected playbook 绑定的 template 二阶段注入后，才允许生成最终报告正文。
- template 注入后只注入 template 正文，不再注入 spec、routing 或 playbook。
- 禁止使用 `brandProductEffectiveness-demo.md`、本地 demo 数据或静态示例值替代 CLI 返回值。
- 对 CLI 未返回的数据，不得自行估算。
