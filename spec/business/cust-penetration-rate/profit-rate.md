---
id: business-cust-penetration-rate-profit-rate
kind: spec
domain: business
title: 门店毛利率指标报告规则
tags:
  - report
  - metric
  - business-report
  - cust-penetration-rate
  - profitRate
match:
  keywords:
    - 门店毛利率
    - profitRate
    - 门店毛利率情况
    - 门店毛利率为什么下降
    - 门店毛利率为什么提升
---

# 门店毛利率指标报告规则

该文件用于经营分析下客数渗透率树中的门店毛利率专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `门店毛利率` 或 `profitRate`。

## 指标位置

- 当前指标 code：`profitRate`
- 当前指标中文名：门店毛利率
- 上级指标：客数渗透率 `custPenetrationRate`
- 父指标：全链路毛利率 `fullLinkStoreProfitNotaxRate`
- 同组指标：供应链毛利率 `scmStoreProfitNotaxRate`

固定拆解链路：

`客数渗透率 -> 全链路毛利率 -> 门店毛利率`

## 边界与禁放规则

- 门店毛利率是当前主指标，全链路毛利率和客数渗透率只能用于父级传导。
- 供应链毛利率只能作为同组补充，不得替代主指标。
- 门店毛利额、供应链毛利额、销售额、客数、客单价及其下游指标不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位门店毛利率结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
