---
id: business-cust-penetration-rate-bf19-category-store-cust-rate
kind: spec
domain: business
title: 19点前PI值指标报告规则
tags:
  - report
  - metric
  - business-report
  - cust-penetration-rate
  - bf19CategoryStoreCustRate
match:
  keywords:
    - 19点前PI值
    - bf19CategoryStoreCustRate
    - 19点前PI值情况
    - 19点前PI值为什么下降
    - 19点前PI值为什么提升
---

# 19点前PI值指标报告规则

该文件用于经营分析下客数渗透率树中的 19点前PI值专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `19点前PI值` 或 `bf19CategoryStoreCustRate`。

## 指标位置

- 当前指标 code：`bf19CategoryStoreCustRate`
- 当前指标中文名：19点前PI值
- 上级指标：客数渗透率 `custPenetrationRate`、客数 `custNum`
- 父指标：19点前客数 `bf19CustNum`
- 同组指标：19点前复购率 `bf19MemberRepurchaseRate`

固定拆解链路：

`客数渗透率 -> 客数 -> 19点前客数 -> 19点前PI值`

## 边界与禁放规则

- 19点前PI值是当前主指标，19点前客数、客数和客数渗透率只能用于父级传导。
- 19点前复购率只能作为同组补充，不得替代主指标。
- 销售额、19点前销售占比、19点前销售重量、订单满足率、客单价、毛利率、毛利额及其下游指标不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位 19点前PI值结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
