---
id: business-brand-product-effectiveness-pre-price-profit-rate
kind: spec
domain: business
title: 定价毛利率指标报告规则
tags:
  - report
  - metric
  - business-report
  - brand-product-effectiveness
  - prePriceProfitRate
match:
  keywords:
    - 定价毛利率
    - prePriceProfitRate
    - 定价毛利率情况
    - 定价毛利率为什么下降
    - 定价毛利率为什么提升
---

# 定价毛利率指标报告规则

该文件用于经营分析下品效树中的定价毛利率专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `定价毛利率` 或 `prePriceProfitRate`。

固定拆解链路：

`品效 -> 定价毛利率 -> 预期毛利率、出库折让率、时段折扣率、促销折扣率、损耗率`

## 指标位置

- 当前指标 code：`prePriceProfitRate`
- 当前指标中文名：定价毛利率
- 父指标：品效 `brandProductEffectiveness`
- 子指标：预期毛利率 `preProfitRate`、出库折让率 `scmPromotionTotalRate`、时段折扣率 `hourDiscountRate`、促销折扣率 `promotionDiscountRate`、损耗率 `lostRate`

## 边界与禁放规则

- 品效只用于父级传导，不能替代定价毛利率主指标。
- 商品订购渗透率、售价价格指数、采购价格指数不得作为本报告主指标行；这些属于品效其他专项。
- 客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额、活跃供应商数不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位定价毛利率结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
