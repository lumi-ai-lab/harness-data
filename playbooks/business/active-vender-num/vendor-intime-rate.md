---
id: playbook-business-active-vender-num-vendor-intime-rate
kind: playbook
domain: business
title: 准点率指标报告 Playbook
tags:
  - playbook
  - active-vender-num
  - vendorIntimeRate
match:
  keywords:
    - 准点率
    - vendorIntimeRate
    - 准点率情况
    - 准点率为什么下降
    - 准点率为什么提升
template: templates/business/active-vender-num/vendor-intime-rate-report.md
---

# 准点率指标报告 Playbook

## 目标

把“查看准点率情况”“分析准点率为什么下降/提升”等问题输出为经营分析下活跃供应商数树中的准点率专项报告。

## 适用边界

适用于：

- 查看昨天的准点率情况
- 准点率为什么下降
- 准点率为什么提升
- vendorIntimeRate 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问活跃供应商数、三率综合得分、准确率、合格率、集采入库占比、品效、客数渗透率等其他指标专项的问题。

## CLI 探索结论

已对 `准点率` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 准点率 --ai` 可返回固定链路 `活跃供应商数 -> 三率综合得分 -> 准点率`，当前指标为 `vendorIntimeRate`。
- `report business indicators --date 2026-05-23 --indicator 准点率 --ai` 可返回准点率当前值、同比、环比、阈值字段；样本中阈值为 `GE 99`。
- `report business tree --values --date 2026-05-23 --indicator 准点率` 可返回经营分析完整树，selected indicator 为 `vendorIntimeRate`，父指标为 `threeRateScore`。
- `report business tree --chart --date 2026-05-23 --indicator 准点率 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area --date 2026-05-23 --indicator 准点率 --ai` 可返回区域准点率，样本中长沙、天津达到 100%，多区域低于 99%，西安和运营直管明显异常。
- `report business category --date 2026-05-23 --indicator 准点率 --ai` 可返回品类准点率，样本中各品类均低于 99% 阈值。
- `report business trend --date 2026-05-23 --indicator 准点率 --ai` 可返回近 30 天趋势，样本中 2026/05/23 降至 0.9138194798572157。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `准点率`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 准点率 --ai`
- `report business tree --values <time_filter> --indicator 准点率`
- `report business tree --chart <time_filter> --indicator 准点率`
- `report business area <time_filter> --indicator 准点率 --ai`
- `report business category <time_filter> --indicator 准点率 --ai`
- `report business trend <time_filter> --indicator 准点率 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 准点率 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 准点率 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 准点率 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 准点率 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 准点率 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 准点率 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的准点率及必要的父级三率综合得分、活跃供应商数传导证据。
- 准确率、合格率只作同组对照，不能替代准点率主指标。
- 区域、品类、趋势证据只作为准点率链路的结构性佐证。
- 低于阈值的区域或品类可描述为履约时效风险；高于或等于阈值的区域或品类可描述为达标支撑。
- CLI 返回 null、0 或跳点时，只能描述为数据异常或结构异常，不能估算修正。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
