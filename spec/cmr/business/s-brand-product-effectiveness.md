---
id: business-s-brand-product-effectiveness
kind: spec
domain: business
title: 品效指标详情
tags:
  - report
  - metric
  - business-report
  - brandProductEffectiveness
  - 品效
match:
  keywords:
    - 品效
    - 品效指标
    - 品效详情
    - brandProductEffectiveness
    - 商品经营效率
---

# 品效指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code brandProductEffectiveness --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 品效 |
| 指标英文 code | `brandProductEffectiveness` |
| 业务定义 | 平均每个动销商品的销售额贡献 |
| 统计逻辑 | 店日均销售额 / 店日均销售sku数 |
| 业务环节 | 采购环节 |

## 指标定位

- 品效是经营分析 `/report/2` 的三大一级核心指标之一（另两个为客数渗透率、活跃供应商数）。
- 所属维度：品效维度。
- 报告章节：第二章 核心指标总览 + 第四章 品效维度深度拆解。
- 固定拆解链路：`品效 -> 商品订购渗透率、定价毛利率、售价价格指数 -> 订购门店数、可订门店数、预期毛利率、出库折让率、时段折扣率、促销折扣率、损耗率、采购价格指数`。

## 下钻子指标

| 层级 | 指标 | code | 所属指标组 |
| :--- | :--- | :--- | :--- |
| 一级子指标 | 商品订购渗透率 | `orderArticleRate` | 商品订购渗透 |
| 一级子指标 | 定价毛利率 | `prePriceProfitRate` | 盈利基础 |
| 一级子指标 | 售价价格指数(线上) | `priceIndex` | 盈利基础 |
| 二级子指标 | 订购门店数 | `orderStores` | 商品订购渗透 |
| 二级子指标 | 可订门店数 | `storeCanOrders` | 商品订购渗透 |
| 二级子指标 | 预期毛利率 | `preProfitRate` | 定价与折扣策略 |
| 二级子指标 | 出库折让率 | `scmPromotionTotalRate` | 履约与损耗 |
| 二级子指标 | 时段折扣率 | `hourDiscountRate` | 定价与折扣策略 |
| 二级子指标 | 促销折扣率 | `promotionDiscountRate` | 定价与折扣策略 |
| 二级子指标 | 损耗率 | `lostRate` | 履约与损耗 |
| 二级子指标 | 采购价格指数 | `purchasePriceIndex` | 定价与折扣策略 |

## 边界与禁放规则

- 销售额、客数、客单价、19点前链路指标不得放入品效章节作为主指标行。
- 准确率、准点率、合格率、三率综合得分、活跃供应商数不得放入品效章节。
- 出库折让率固定归入品效定价毛利率拆解，不得放入供应链章节。
- 区域、品类、趋势证据只能用于解释品效及其下钻链路，不得扩展为经营总览。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。