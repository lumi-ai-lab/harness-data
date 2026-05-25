---
id: business-cust-penetration-rate-satisfied-rate
kind: spec
domain: business
title: 订单满足率指标报告规则
tags:
  - metric
  - cust-penetration-rate
  - satisfiedRate
match:
  keywords:
    - 订单满足率
    - satisfiedRate
    - 订单满足率情况
    - 订单满足率为什么下降
    - 订单满足率为什么提升
---

# 订单满足率指标报告规则

该文件用于经营分析下客数渗透率树中的订单满足率专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `订单满足率` 或 `satisfiedRate`。

固定拆解链路：

`客数渗透率 -> 销售额 -> 19点前销售占比 -> 订单满足率`

## 指标位置

- 当前指标 code：`satisfiedRate`
- 当前指标中文名：订单满足率
- 父指标：19点前销售占比 `bf19SaleRate`
- 上级指标：销售额 `saleAmt`、客数渗透率 `custPenetrationRate`
- 同组指标：19点前销售重量 `bf19SaleWeight`

## 边界与禁放规则

- 订单满足率是本报告唯一主指标。
- 19点前销售占比和销售额只用于父级传导，不能替代订单满足率主指标。
- 订单满足率若存在区间阈值，高于上限和低于下限都按偏离处理。
- 19点前销售重量只可作为同组成交参考，不能作为本报告主指标。
- 客数、客单价、全链路毛利率、全链路毛利额、品效、活跃供应商数不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位订单满足率结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
