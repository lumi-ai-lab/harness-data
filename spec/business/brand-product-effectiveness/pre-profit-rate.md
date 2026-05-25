---
id: business-brand-product-effectiveness-pre-profit-rate
kind: spec
domain: business
title: 预期毛利率指标报告规则
tags:
  - report
  - metric
  - business-report
  - brand-product-effectiveness
  - preProfitRate
match:
  keywords:
    - 预期毛利率
    - preProfitRate
    - 预期毛利率情况
    - 预期毛利率为什么下降
    - 预期毛利率为什么提升
---

# 预期毛利率指标报告规则

该文件用于经营分析下品效树中定价毛利率链路的预期毛利率专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `预期毛利率` 或 `preProfitRate`。

固定拆解链路：

`品效 -> 定价毛利率 -> 预期毛利率 -> 出库折让率`

## 指标位置

- 当前指标 code：`preProfitRate`
- 当前指标中文名：预期毛利率
- 祖父指标：品效 `brandProductEffectiveness`
- 父指标：定价毛利率 `prePriceProfitRate`
- 子指标：出库折让率 `scmPromotionTotalRate`

## 边界与禁放规则

- 预期毛利率是当前主指标，定价毛利率和品效只能用于父级传导。
- 出库折让率只能作为子项影响解释，不得替代主指标。
- 时段折扣率、促销折扣率、损耗率不得作为本报告主指标行；这些属于定价毛利率其他专项。
- 商品订购渗透率、售价价格指数、采购价格指数、客数渗透率、销售额、活跃供应商数不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位预期毛利率结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
