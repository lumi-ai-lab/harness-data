---
id: business-cust-penetration-rate-bf19-sale-weight
kind: spec
domain: business
title: 19点前销售重量指标报告规则
tags:
  - metric
  - cust-penetration-rate
  - bf19SaleWeight
match:
  keywords:
    - 19点前销售重量
    - bf19SaleWeight
    - 19点前销售重量情况
    - 19点前销售重量为什么下降
    - 19点前销售重量为什么提升
---

# 19点前销售重量指标报告规则

该文件用于经营分析下客数渗透率树中的19点前销售重量专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `19点前销售重量` 或 `bf19SaleWeight`。

固定拆解链路：

`客数渗透率 -> 销售额 -> 19点前销售占比 -> 19点前销售重量`

## 指标位置

- 当前指标 code：`bf19SaleWeight`
- 当前指标中文名：19点前销售重量
- 父指标：19点前销售占比 `bf19SaleRate`
- 上级指标：销售额 `saleAmt`、客数渗透率 `custPenetrationRate`
- 同组指标：订单满足率 `satisfiedRate`

## 边界与禁放规则

- 19点前销售重量是本报告唯一主指标。
- 19点前销售占比和销售额只用于父级传导，不能替代19点前销售重量主指标。
- 订单满足率只可作为同组履约约束参考，不能作为本报告主指标。
- 客数、客单价、全链路毛利率、全链路毛利额、品效、活跃供应商数不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位19点前销售重量结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
