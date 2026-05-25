---
id: business-cust-penetration-rate-full-link-store-profit-amt-notax
kind: spec
domain: business
title: 全链路毛利额指标报告规则
tags:
  - report
  - metric
  - business-report
  - cust-penetration-rate
  - fullLinkStoreProfitAmtNotax
match:
  keywords:
    - 全链路毛利额
    - fullLinkStoreProfitAmtNotax
    - 全链路毛利额情况
    - 全链路毛利额为什么下降
    - 全链路毛利额为什么提升
---

# 全链路毛利额指标报告规则

该文件用于经营分析下客数渗透率树中的全链路毛利额专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `全链路毛利额` 或 `fullLinkStoreProfitAmtNotax`。

固定拆解链路：

`客数渗透率 -> 全链路毛利额 -> 门店毛利额、供应链毛利额`

## 指标位置

- 当前指标 code：`fullLinkStoreProfitAmtNotax`
- 当前指标中文名：全链路毛利额
- 父指标：客数渗透率 `custPenetrationRate`
- 子指标：门店毛利额 `profitAmt`、供应链毛利额 `scmStoreProfitAmtNotax`

## 边界与禁放规则

- 客数渗透率只用于父级传导，不能替代全链路毛利额主指标。
- 销售额、客数、客单价及 19 点前链路不得作为本报告主指标行。
- 全链路毛利率、门店毛利率、供应链毛利率不得混入本报告主指标行；这些属于毛利率专项。
- 品效、商品订购渗透率、定价毛利率、售价价格指数、活跃供应商数、供应商三率不得作为本报告指标行。
- 区域、品类、趋势证据可用于定位全链路毛利额结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
