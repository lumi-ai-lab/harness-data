---
id: business-s-full-link-store-profit-amt-notax
kind: spec
domain: business
title: 全链路毛利额指标详情
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
    - 全链路毛利额详情
    - 全链路毛利额指标详情
---

# 全链路毛利额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code fullLinkStoreProfitAmtNotax --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 全链路到店毛利额（不含税） |
| 指标英文 code | `fullLinkStoreProfitAmtNotax` |
| 业务定义 | 从商品采购入库到门店销售全流程产生的税前毛利，不包含非到店业务的商品产生的毛利 |
| 统计逻辑 | 供应链到店毛利额（不含税）+门店毛利额 |
| 业务环节 | 全链路 |

## 指标定位

- 全链路毛利额是客数渗透率维度下全链路盈利组的汇总指标。
- 所属维度：客数渗透率维度（用户渗透维度）。
- 报告章节：第三章 用户渗透维度深度拆解。
- 固定拆解链路：`客数渗透率 -> 全链路毛利额 -> 门店毛利额、供应链毛利额`。
- 上级指标：客数渗透率 `custPenetrationRate`。
- 子指标：门店毛利额 `profitAmt`、供应链毛利额 `scmStoreProfitAmtNotax`。

## 下钻子指标

| 层级 | 指标 | code | 所属指标组 |
| :--- | :--- | :--- | :--- |
| 子指标 | 门店毛利额 | `profitAmt` | 全链路盈利 |
| 子指标 | 供应链毛利额 | `scmStoreProfitAmtNotax` | 全链路盈利 |

## 边界与禁放规则

- 客数渗透率只用于父级传导，不能替代全链路毛利额主指标。
- 销售额、客数、客单价及 19 点前链路不得作为本报告主指标行。
- 全链路毛利率、门店毛利率、供应链毛利率不得混入本报告主指标行。
- 品效、商品订购渗透率、定价毛利率、售价价格指数、活跃供应商数、供应商三率不得作为本报告指标行。
- 禁放：第四章（品效维度）、第五章（供应链维度）。
- 区域、品类、趋势证据可用于定位全链路毛利额结构分化和异常。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。