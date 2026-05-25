---
id: business-cust-penetration-rate-cust-num
kind: spec
domain: business
title: 客数指标报告规则
tags:
  - report
  - metric
  - business-report
  - cust-penetration-rate
  - custNum
match:
  keywords:
    - 客数
    - custNum
    - 客数情况
    - 客数为什么下降
    - 客数为什么提升
---

# 客数指标报告规则

该文件用于经营分析下客数渗透率树中的客数专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `客数` 或 `custNum`。

## 指标位置

- 当前指标 code：`custNum`
- 当前指标中文名：客数
- 父指标：客数渗透率 `custPenetrationRate`
- 子指标：19点前客数 `bf19CustNum`
- 叶子指标：19点前PI值 `bf19CategoryStoreCustRate`、19点前复购率 `bf19MemberRepurchaseRate`

固定拆解链路：

`客数渗透率 -> 客数 -> 19点前客数 -> 19点前PI值、19点前复购率`

## 边界与禁放规则

- 客数渗透率只用于父级传导，不能替代客数主指标。
- 销售额、19点前销售占比、客单价、毛利率、毛利额及其下游指标不得作为客数报告主指标行。
- 品效、商品订购渗透率、活跃供应商数、供应商三率不得作为客数报告指标行。
- 区域、品类、趋势证据可用于定位客数结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
