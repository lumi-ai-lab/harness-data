---
id: business-brand-product-effectiveness-lost-rate
kind: spec
domain: business
title: 损耗率指标报告规则
tags:
  - report
  - metric
  - business-report
  - brand-product-effectiveness
  - lostRate
match:
  keywords:
    - 损耗率
    - lostRate
    - 损耗率情况
    - 损耗率为什么下降
    - 损耗率为什么提升
---

# 损耗率指标报告规则

该文件用于经营分析下品效树中定价毛利率链路的损耗率专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `损耗率` 或 `lostRate`。

固定拆解链路：

`品效 -> 定价毛利率 -> 损耗率`

## 指标位置

- 当前指标 code：`lostRate`
- 当前指标中文名：损耗率
- 祖父指标：品效 `brandProductEffectiveness`
- 父指标：定价毛利率 `prePriceProfitRate`
- 子指标：无

## 边界与禁放规则

- 品效、定价毛利率只用于父级传导，不能替代损耗率主指标。
- 预期毛利率、出库折让率、时段折扣率、促销折扣率不得作为本报告主指标行；这些属于定价毛利率其他专项。
- 商品订购渗透率、售价价格指数、客数渗透率、销售额、活跃供应商数不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位损耗率结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
