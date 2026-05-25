---
id: playbook-business-active-vender-num-vendor-qualification-rate
kind: playbook
domain: business
title: 合格率指标报告 Playbook
tags:
  - playbook
  - active-vender-num
  - vendorQualificationRate
match:
  keywords:
    - 合格率
    - vendorQualificationRate
    - 合格率情况
    - 合格率为什么下降
    - 合格率为什么提升
template: templates/business/active-vender-num/vendor-qualification-rate-report.md
---

# 合格率指标报告 Playbook

## 目标

把“查看合格率情况”“分析合格率为什么下降/提升”等问题输出为经营分析下活跃供应商数树中的合格率专项报告。

## 适用边界

适用于：

- 查看昨天的合格率情况
- 合格率为什么下降
- 合格率为什么提升
- vendorQualificationRate 指标报告

不适用于：

- 泛问经营情况、经营报告、整体业务表现的问题；此类问题走 `playbooks/business/default-overview.md`。
- 用户只问活跃供应商数、三率综合得分、准确率、准点率、集采入库占比、品效、客数渗透率等其他指标专项的问题。

## CLI 探索结论

已对 `合格率` 使用 2026-05-23 小样本验证：

- `search indicators tree --report business --keyword 合格率 --ai` 可返回固定链路 `活跃供应商数 -> 三率综合得分 -> 合格率`，当前指标为 `vendorQualificationRate`。
- `report business indicators --date 2026-05-23 --indicator 合格率 --ai` 可返回合格率当前值、同比、环比、阈值字段；样本中阈值为 `GE 99`。
- `report business tree --values --date 2026-05-23 --indicator 合格率` 可返回经营分析完整树，selected indicator 为 `vendorQualificationRate`，父指标为 `threeRateScore`。
- `report business tree --chart --date 2026-05-23 --indicator 合格率 --with-meta` 可返回所选指标的 area、category、trend 图表数据。
- `report business area --date 2026-05-23 --indicator 合格率 --ai` 可返回区域合格率，样本中南京、西安、合肥、天津达到 100%，武汉和运营直管明显异常。
- `report business category --date 2026-05-23 --indicator 合格率 --ai` 可返回品类合格率，样本中预制菜、猪肉达到 100%，水果、蔬菜低于 99% 阈值。
- `report business trend --date 2026-05-23 --indicator 合格率 --ai` 可返回近 30 天趋势，样本中 2026/05/23 为 0.9912289648138705。

## 必要查询模块

使用 `qdm-cmr-cli report business`，固定指标为 `合格率`。六个模块是硬性要求，可以并行查询；必须全部成功后立即执行 `bin/data-harness-cli inject-template`。

- `report business indicators <time_filter> --indicator 合格率 --ai`
- `report business tree --values <time_filter> --indicator 合格率`
- `report business tree --chart <time_filter> --indicator 合格率`
- `report business area <time_filter> --indicator 合格率 --ai`
- `report business category <time_filter> --indicator 合格率 --ai`
- `report business trend <time_filter> --indicator 合格率 --ai`

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business indicators <time_filter> --indicator 合格率 --ai &
"$QDM_CMR_CLI" report business tree --values <time_filter> --indicator 合格率 &
"$QDM_CMR_CLI" report business tree --chart <time_filter> --indicator 合格率 &
"$QDM_CMR_CLI" report business area <time_filter> --indicator 合格率 --ai &
"$QDM_CMR_CLI" report business category <time_filter> --indicator 合格率 --ai &
"$QDM_CMR_CLI" report business trend <time_filter> --indicator 合格率 --ai &
wait

bin/data-harness-cli inject-template
```

## 证据与异常规则

- 最终报告只使用 CLI 返回的合格率及必要的父级三率综合得分、活跃供应商数传导证据。
- 准确率、准点率只作同组对照，不能替代合格率主指标。
- 区域、品类、趋势证据只作为合格率链路的结构性佐证。
- 低于阈值的区域或品类可描述为交付质量风险；高于或等于阈值的区域或品类可描述为达标支撑。
- CLI 返回 null、0 或跳点时，只能描述为数据异常或结构异常，不能估算修正。
- template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析。
- 若必要模块失败或 `inject-template` 未成功，不得生成最终报告。
