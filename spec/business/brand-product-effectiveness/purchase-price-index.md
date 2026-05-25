---
id: business-brand-product-effectiveness-purchase-price-index
kind: spec
domain: business
title: 采购价格指数指标报告规则
tags:
  - metric
  - brand-product-effectiveness
  - purchasePriceIndex
match:
  keywords:
    - 采购价格指数
    - purchasePriceIndex
    - 采购价格指数情况
    - 采购价格指数为什么下降
    - 采购价格指数为什么提升
---

# 采购价格指数指标报告规则

该文件用于经营分析下品效树中的采购价格指数专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `采购价格指数` 或 `purchasePriceIndex`。

固定拆解链路：

`品效 -> 售价价格指数(线上) -> 采购价格指数`

## 指标位置

- 当前指标 code：`purchasePriceIndex`
- 当前指标中文名：采购价格指数
- 父指标：售价价格指数(线上) `priceIndex`
- 上级指标：品效 `brandProductEffectiveness`

## 边界与禁放规则

- 采购价格指数是本报告唯一主指标。
- 售价价格指数(线上)只用于父级传导，不能替代采购价格指数主指标。
- 品效、商品订购渗透率、定价毛利率、损耗率不得作为本报告主指标行；这些属于品效其他专项或上级传导。
- 客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额、活跃供应商数不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位采购价格指数结构分化、采购成本压力和数据异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
