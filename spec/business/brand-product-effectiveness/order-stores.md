---
id: business-brand-product-effectiveness-order-stores
kind: spec
domain: business
title: 订购门店数指标报告规则
tags:
  - report
  - metric
  - business-report
  - brand-product-effectiveness
  - orderStores
match:
  keywords:
    - 订购门店数
    - orderStores
    - 订购门店数情况
    - 订购门店数为什么下降
    - 订购门店数为什么提升
---

# 订购门店数指标报告规则

该文件用于经营分析下品效树中商品订购渗透率链路的订购门店数专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `订购门店数` 或 `orderStores`。

固定拆解链路：

`品效 -> 商品订购渗透率 -> 订购门店数`

## 指标位置

- 当前指标 code：`orderStores`
- 当前指标中文名：订购门店数
- 祖父指标：品效 `brandProductEffectiveness`
- 父指标：商品订购渗透率 `orderArticleRate`
- 同组指标：可订门店数 `storeCanOrders`
- 子指标：无

## 边界与禁放规则

- 订购门店数是当前主指标，商品订购渗透率和品效只能用于父级传导。
- 可订门店数只能作为同组补充，不得替代主指标。
- 定价毛利率、售价价格指数、采购价格指数、损耗率、客数渗透率、销售额、活跃供应商数不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位订购门店数覆盖分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
