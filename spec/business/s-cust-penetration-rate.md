---
id: business-s-cust-penetration-rate
kind: spec
domain: business
title: 客数渗透率指标详情
tags:
  - report
  - metric
  - business-report
  - custPenetrationRate
  - 用户渗透
match:
  keywords:
    - 客数渗透率
    - 客数渗透率指标
    - 客数渗透率详情
    - 客流渗透率
    - custPenetrationRate
    - 用户渗透
    - custPenetrationRate指标
---

# 客数渗透率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code custPenetrationRate --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 客流渗透率（报告别名：客数渗透率） |
| 指标英文 code | `custPenetrationRate` |
| 业务定义 | 到店的客流占门店300米半径范围覆盖的小区户数的占比 |
| 统计逻辑 | 来客数 / 门店覆盖户数；如果门店复购户数为空，则客流渗透率为空，使用"--"表示 |
| 业务环节 | 用户渗透 |

## 指标定位

- 客数渗透率是经营分析 `/report/2` 的三大一级核心指标之一（另两个为品效、活跃供应商数）。
- 所属维度：用户渗透维度。
- 报告章节：第二章 核心指标总览 + 第三章 用户渗透维度深度拆解。
- 固定拆解链路：`客数渗透率 -> 销售额、客数、客单价、全链路毛利率、全链路毛利额`。
- 模板结构：一级核心指标，10 章完整模板。

## 下钻子指标

| 层级 | 指标 | code | 所属指标组 |
| :--- | :--- | :--- | :--- |
| 一级子指标 | 销售额 | `saleAmt` | 规模类指标 |
| 一级子指标 | 客数 | `custNum` | 规模类指标 |
| 一级子指标 | 客单价 | `perCustAmt` | 规模类指标 |
| 一级子指标 | 全链路毛利率 | `fullLinkStoreProfitNotaxRate` | 全链路盈利 |
| 一级子指标 | 全链路毛利额 | `fullLinkStoreProfitAmtNotax` | 全链路盈利 |

## 边界与禁放规则

- 品效指标（定价毛利率、售价价格指数、预期毛利率、出库折让率、时段折扣率、促销折扣率、损耗率、采购价格指数）不得放入用户渗透章节作为主指标行。
- 活跃供应商数、三率综合得分、准确率、准点率、合格率、集采入库占比不得放入用户渗透章节。
- 区域、品类、趋势证据只能用于解释客数渗透率及其下钻链路，不得扩展为经营总览。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。