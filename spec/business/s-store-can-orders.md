---
id: business-s-store-can-orders
kind: spec
domain: business
title: 可订门店数指标详情
tags:
  - report
  - metric
  - business-report
  - storeCanOrders
  - 可订门店数
match:
  keywords:
    - 可订门店数
    - 可订门店数指标
    - 可订门店数详情
    - storeCanOrders
---

# 可订门店数指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code storeCanOrders --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 可订门店数 |
| 指标英文 code | `storeCanOrders` |
| 业务定义 | 平均每个商品每天根据被设置为可订购的门店数 |
| 统计逻辑 | 统计期内，按商品-日统计：被设置为可订购的门店数 |
| 业务环节 | 采购环节 |

## 指标定位

- 所属维度：品效维度。
- 父指标：商品订购渗透率（`orderArticleRate`）。
- 报告章节：第四章 品效维度深度拆解。
- 拆解链路：`品效 -> 商品订购渗透率 -> 可订门店数`。
- 所属指标组：商品订购渗透。

## 下钻子指标

该指标为叶子指标，无子指标。

## 边界与禁放规则

- 可订门店数不得放入第三章（客数渗透率维度）、第五章（活跃供应商数维度）。
- 区域、品类、趋势证据只能用于解释可订门店数及其父指标商品订购渗透率，不得扩展为经营总览。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。