---
id: business-brand-product-effectiveness-price-index
kind: spec
domain: business
title: 售价价格指数指标报告规则
tags:
  - report
  - metric
  - business-report
  - brand-product-effectiveness
  - priceIndex
match:
  keywords:
    - 售价价格指数
    - 售价价格指数(线上)
    - priceIndex
    - 售价价格指数情况
    - 售价价格指数为什么下降
    - 售价价格指数为什么提升
---

# 售价价格指数指标报告规则

该文件用于经营分析下品效树中的售价价格指数(线上)专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `售价价格指数(线上)` 或 `priceIndex`。

固定拆解链路：

`品效 -> 售价价格指数(线上) -> 采购价格指数`

## 指标位置

- 当前指标 code：`priceIndex`
- 当前指标中文名：售价价格指数(线上)
- 父指标：品效 `brandProductEffectiveness`
- 子指标：采购价格指数 `purchasePriceIndex`

## 边界与禁放规则

- 品效只用于父级传导，不能替代售价价格指数主指标。
- 商品订购渗透率、定价毛利率不得作为本报告主指标行；这些属于品效其他专项。
- 客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额、活跃供应商数不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位售价价格指数结构分化、价格风险和数据异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
