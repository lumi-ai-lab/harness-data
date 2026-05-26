---
id: business-s-bf19-category-store-cust-rate
kind: spec
domain: business
title: 19点前PI值指标详情
tags:
  - report
  - metric
  - business-report
  - cust-penetration-rate
  - bf19CategoryStoreCustRate
match:
  keywords:
    - 19点前PI值
    - bf19CategoryStoreCustRate
    - 19点前PI值情况
    - 19点前PI值为什么下降
    - 19点前PI值为什么提升
---

# 19点前PI值指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code bf19CategoryStoreCustRate --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 19点前PI值 |
| 指标英文 code | `bf19CategoryStoreCustRate` |
| 业务定义 | 19点前，每个品类占门店19点前客流的占比 |
| 统计逻辑 | 19点前品类客数 / 门店19点前客数 |
| 业务环节 | 销售经营 |

## 指标定位

- 19点前PI值是经营分析 `/report/2` 中客数渗透率树的叶子指标，无下钻子指标。
- 所属维度：客数渗透率维度，19点前链路。
- 固定拆解链路：`客数渗透率 -> 客数 -> 19点前客数 -> 19点前PI值`。
- 父指标：19点前客数 `bf19CustNum`。
- 同组指标：19点前复购率 `bf19MemberRepurchaseRate`。
- 19点前PI值无阈值配置，CLI 不返回 threshold 字段。

## 边界与禁放规则

- 19点前PI值是当前主指标，19点前客数、客数和客数渗透率只能用于父级传导。
- 19点前复购率只能作为同组补充，不得替代主指标。
- 销售额、客单价、19点前客单价、19点前单均件数、19点前件单价、19点前平均销售价、19点前客单重量及其下游指标不得作为本报告主指标行。
- 19点前销售占比（bf19SaleRate）、19点前销售重量（bf19SaleWeight）、订单满足率不得作为本报告主指标行。
- 品效、商品订购渗透率、定价毛利率、售价价格指数、活跃供应商数、供应商三率不得作为本报告指标行。
- 毛利率（门店毛利率、全链路毛利率、供应链毛利率）、毛利额及其下游指标不得作为本报告指标行。
- 区域、品类、趋势证据只能用于解释19点前PI值结构分化和异常，不得扩展为经营总览。
- 全品类PI值=100%为正常现象（品类客数=门店客数），不得解释为异常。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。
- 根因必须受 CLI 证据约束；CLI 只支持趋势或结构异常时，只能写"可能""倾向于"。