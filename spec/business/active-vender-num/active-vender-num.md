---
id: business-active-vender-num-active-vender-num
kind: spec
domain: business
title: 活跃供应商数指标报告规则
tags:
  - report
  - metric
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

# 活跃供应商数指标报告规则

该文件用于经营分析下活跃供应商数树中的活跃供应商数专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `活跃供应商数` 或 `activeVenderNum`。

固定拆解链路：

`活跃供应商数 -> 集采入库占比、三率综合得分 -> 准确率、准点率、合格率`

## 指标位置

- 当前指标 code：`activeVenderNum`
- 当前指标中文名：活跃供应商数
- 子指标：集采入库占比 `centralInstockRate`、三率综合得分 `threeRateScore`
- 叶子指标：准确率 `vendorAccuracyRate`、准点率 `vendorIntimeRate`、合格率 `vendorQualificationRate`

## 边界与禁放规则

- 集采入库占比、三率综合得分、准确率、准点率、合格率只用于活跃供应商数链路拆解。
- 品效、客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位活跃供应商数结构分化、供应商规模风险和履约质量异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
