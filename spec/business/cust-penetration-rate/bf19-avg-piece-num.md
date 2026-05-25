---
id: business-cust-penetration-rate-bf19-avg-piece-num
kind: spec
domain: business
title: 19点前单均件数指标报告规则
tags:
  - report
  - metric
  - business-report
  - cust-penetration-rate
  - bf19AvgPieceNum
match:
  keywords:
    - 19点前单均件数
    - bf19AvgPieceNum
    - 19点前单均件数情况
    - 19点前单均件数为什么下降
    - 19点前单均件数为什么提升
---

# 19点前单均件数指标报告规则

该文件用于经营分析下客数渗透率树中的 19点前单均件数专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `19点前单均件数` 或 `bf19AvgPieceNum`。

## 指标位置

- 当前指标 code：`bf19AvgPieceNum`
- 当前指标中文名：19点前单均件数
- 上级指标：客数渗透率 `custPenetrationRate`、客单价 `perCustAmt`
- 父指标：19点前客单价 `bf19PerCustAmt`
- 同组指标：19点前件单价 `bf19PerPieceAmt`

固定拆解链路：

`客数渗透率 -> 客单价 -> 19点前客单价 -> 19点前单均件数`

## 边界与禁放规则

- 19点前单均件数是当前主指标，19点前客单价、客单价和客数渗透率只能用于父级传导。
- 19点前件单价只能作为同组价格补充，不得替代主指标。
- 销售额、19点前销售占比、客数、毛利率、毛利额及其下游指标不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位 19点前单均件数结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
