---
id: business-brand-product-effectiveness-order-article-rate
kind: spec
domain: business
title: 商品订购渗透率指标报告规则
tags:
  - report
  - metric
  - business-report
  - brand-product-effectiveness
  - orderArticleRate
match:
  keywords:
    - 商品订购渗透率
    - orderArticleRate
    - 商品订购渗透率情况
    - 商品订购渗透率为什么下降
    - 商品订购渗透率为什么提升
---

# 商品订购渗透率指标报告规则

该文件用于经营分析下品效树中的商品订购渗透率专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `商品订购渗透率` 或 `orderArticleRate`。

固定拆解链路：

`品效 -> 商品订购渗透率 -> 订购门店数、可订门店数`

## 指标位置

- 当前指标 code：`orderArticleRate`
- 当前指标中文名：商品订购渗透率
- 父指标：品效 `brandProductEffectiveness`
- 子指标：订购门店数 `orderStores`、可订门店数 `storeCanOrders`

## 边界与禁放规则

- 品效只用于父级传导，不能替代商品订购渗透率主指标。
- 定价毛利率、售价价格指数、采购价格指数不得作为本报告主指标行；这些属于品效其他专项。
- 客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额、活跃供应商数不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位商品订购渗透率结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
