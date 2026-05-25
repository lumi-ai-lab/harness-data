---
id: business-active-vender-num-three-rate-score
kind: spec
domain: business
title: 三率综合得分指标报告规则
tags:
  - report
  - metric
  - business-report
  - active-vender-num
  - threeRateScore
match:
  keywords:
    - 三率综合得分
    - threeRateScore
    - 三率综合得分情况
    - 三率综合得分为什么下降
    - 三率综合得分为什么提升
---

# 三率综合得分指标报告规则

该文件用于经营分析下活跃供应商数树中的三率综合得分专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `三率综合得分` 或 `threeRateScore`。

固定拆解链路：

`活跃供应商数 -> 三率综合得分 -> 准确率、准点率、合格率`

## 指标位置

- 当前指标 code：`threeRateScore`
- 当前指标中文名：三率综合得分
- 父指标：活跃供应商数 `activeVenderNum`
- 子指标：准确率 `vendorAccuracyRate`、准点率 `vendorIntimeRate`、合格率 `vendorQualificationRate`

## 边界与禁放规则

- 活跃供应商数只用于父级传导，不能替代三率综合得分主指标。
- 集采入库占比不得作为本报告主指标行；它属于集采结构专项。
- 品效、客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位三率综合得分结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
