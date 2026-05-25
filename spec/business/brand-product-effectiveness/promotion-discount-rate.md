---
id: business-brand-product-effectiveness-promotion-discount-rate
kind: spec
domain: business
title: 促销折扣率指标报告规则
tags:
  - report
  - metric
  - business-report
  - brand-product-effectiveness
  - promotionDiscountRate
match:
  keywords:
    - 促销折扣率
    - promotionDiscountRate
    - 促销折扣率情况
    - 促销折扣率为什么下降
    - 促销折扣率为什么提升
---

# 促销折扣率指标报告规则

该文件用于经营分析下品效树中定价毛利率链路的促销折扣率专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `促销折扣率` 或 `promotionDiscountRate`。

固定拆解链路：

`品效 -> 定价毛利率 -> 促销折扣率`

## 指标位置

- 当前指标 code：`promotionDiscountRate`
- 当前指标中文名：促销折扣率
- 祖父指标：品效 `brandProductEffectiveness`
- 父级指标：定价毛利率 `prePriceProfitRate`
- 子指标：无

## 边界与禁放规则

- 促销折扣率是当前主指标，定价毛利率和品效只能用于父级传导。
- 预期毛利率、出库折让率、时段折扣率、损耗率不得作为本报告主指标行；这些属于定价毛利率其他专项。
- 商品订购渗透率、售价价格指数、采购价格指数、客数渗透率、销售额、活跃供应商数不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位促销折扣率结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
