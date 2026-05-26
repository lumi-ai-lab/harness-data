---
id: business-s-profit-amt
kind: spec
domain: business
title: 门店毛利额指标详情
tags:
  - report
  - metric
  - business-report
  - cust-penetration-rate
  - profitAmt
match:
  keywords:
    - 门店毛利额
    - profitAmt
    - 门店毛利额详情
    - 门店毛利额指标详情
    - 门店毛利额指标
---

# 门店毛利额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code profitAmt --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 门店毛利额 |
| 指标英文 code | `profitAmt` |
| 业务定义 | 销售收入减去销售成本 |
| 统计逻辑 | 销售额-(进货额+门店期初库存金额-门店期末库存金额) |
| 业务环节 | 销售经营 |

## 指标定位

- 门店毛利额是客数渗透率维度下全链路盈利组的叶子指标。
- 所属维度：客数渗透率维度（用户渗透维度）。
- 报告章节：第三章 用户渗透维度深度拆解。
- 归入用户渗透链路中的门店结果指标。
- 固定拆解链路：`客数渗透率 -> 全链路毛利额 -> 门店毛利额`。
- 上级指标：客数渗透率 `custPenetrationRate`。
- 父指标：全链路毛利额 `fullLinkStoreProfitAmtNotax`。
- 同组指标：供应链毛利额 `scmStoreProfitAmtNotax`。

## 下钻子指标

无（叶子指标）。

## 边界与禁放规则

- 门店毛利额是当前主指标，全链路毛利额和客数渗透率只能用于父级传导。
- 供应链毛利额只能作为同组补充，不得替代主指标。
- 全链路毛利率、门店毛利率、供应链毛利率、销售额、客数、客单价及其下游指标不得作为本报告主指标行。
- 禁放：第四章（品效维度）、第五章（供应链维度）。
- 区域、品类、趋势证据可用于定位门店毛利额结构分化和异常。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。