---
id: store-s-water-rent
kind: spec
domain: store
title: 店铺水电费指标详情
tags:
  - report
  - metric
  - store-report
  - waterRent
  - 店铺水电费
match:
  keywords:
    - 店铺水电费
    - 店铺水电费指标
    - 店铺水电费详情
    - waterRent
---

# 店铺水电费指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code waterRent --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 店铺水电费 |
| 指标英文 code | `waterRent` |
| 业务定义 | 门店水电费用合计（万元） |
| 统计逻辑 | 统计周期内门店水费与电费合计 |
| 业务环节 | 门店管理 |

## 指标定位

- 店铺水电费是门店管理 `/report/1` 中盈亏平衡点费用组的组成指标之一。
- 所属维度：门店管理维度。
- 父指标：盈亏平衡点（`breakEvenPoint`），归属费用组（`isGroup: true`，`layout: vertical`）。
- 费用组兄弟指标：员工工资（`storeTotalSalary`）、租金和物业管理费（`storeDormTotalRent`）、门店其他支出（`storeOtherFee`）。
- 报告章节：盈亏平衡点费用拆解章节。

## 下钻子指标

无子指标。店铺水电费为叶子指标，不参与进一步下钻。

## 边界与禁放规则

- 店铺水电费仅出现在盈亏平衡点费用组中，不得放入其他指标组。
- 店铺水电费不得与门店净利润、坪效、人效等非费用类指标放在同一表格中混排。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。