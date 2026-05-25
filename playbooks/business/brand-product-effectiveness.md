---
id: playbook-business-brand-product-effectiveness
kind: playbook
domain: business
title: 品效下钻取数 Playbook
tags:
  - playbook
  - business-report
  - brand-product-effectiveness
match:
  keywords:
    - 品效
    - 品效情况
    - 品效下钻
    - brandProductEffectiveness
    - 商品经营效率
template: templates/business/brand-product-effectiveness-report.md
---

# 品效下钻取数 Playbook

## 目标

把“查看品效情况”“分析品效为什么下降/提升”等问题输出为经营分析下的品效专项下钻报告。

## 适用边界

适用于：

- 查看昨天的品效情况
- 分析昨日品效
- 品效为什么下降
- 品效为什么提升
- 商品经营效率表现如何

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户明确要求指标定义解释、指标平台或非 CMR 报表的问题。

命中该 playbook 后，不向用户追问；若用户未给时间，默认使用昨天，并在报告概述中说明默认口径。

## 必要查询模块

CMR CLI 参数格式、时间过滤、`--ai` 白名单和失败重试规则以 `spec/common/cmr-cli-readme.md` 与 `spec/common/time-policy.md` 为准。

使用 `qdm-cmr-cli report business`，固定指标为 `品效`。六个模块是硬性要求，模块之间没有业务顺序依赖，可以并行查询；必须全部成功后才能进入报告生成阶段。六个模块全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 品效 --ai`
- `report business tree --values <time_filter> --indicator 品效`
- `report business tree --chart <time_filter> --indicator 品效`
- `report business area <time_filter> --indicator 品效 --ai`
- `report business category <time_filter> --indicator 品效 --ai`
- `report business trend <time_filter> --indicator 品效 --ai`

推荐并行查询方式：

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

## 分析步骤

1. 明确时间口径和筛选口径。
2. 并行查询 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
3. 若六个模块均成功，立即执行 `bin/data-harness-cli inject-template`。
4. template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
5. inject-template 成功并收到 template 二阶段注入后，再按 template 组织最终报告正文。

## 证据规则

- 最终报告只使用 CLI 返回的品效、商品订购渗透率、定价毛利率、售价价格指数及其下钻指标。
- 区域、品类、趋势证据只作为品效链路的结构性佐证。
- 数值、排名、同比、环比、阈值、异常点必须来自 CLI 输出。
- CLI 未返回的指标行、指标组或段落直接省略。
- 不使用 `brandProductEffectiveness-demo.md`、本地静态示例值或经验估算值。

## 异常处理

- 若必要模块查询失败，先重试或调整合法参数；仍失败时不得生成最终报告。
- 若某个必要模块成功但返回数据为空，保留已返回证据；不得在 template 注入前继续分析或补造缺失指标。
- 六个必要模块全部成功后，若未立即执行 `bin/data-harness-cli inject-template`，不得输出任何总结、素材整理或中间分析。
- 若 `bin/data-harness-cli inject-template` 未成功，或未收到 template 二阶段注入，不得输出最终报告正文。
