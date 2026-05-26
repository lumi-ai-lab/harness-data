---
id: store-s-store-dorm-total-rent
kind: spec
domain: store
title: 租金和物业管理费指标详情
tags:
  - report
  - metric
  - store-report
  - storeDormTotalRent
  - 租金和物业管理费
match:
  keywords:
    - 租金和物业管理费
    - 租金和物业管理费指标
    - 租金和物业管理费详情
    - storeDormTotalRent
---

# 租金和物业管理费指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code storeDormTotalRent --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 租金和物业管理费 |
| 指标英文 code | `storeDormTotalRent` |
| 业务定义 | 门店租金及物业管理费用合计（万元） |
| 统计逻辑 | 统计周期内门店租金与物业管理费合计 |
| 业务环节 | 门店管理 |

## 指标定位

- 租金和物业管理费是门店管理 `/report/1` 中盈亏平衡点费用组的组成指标之一。
- 所属维度：门店管理维度。
- 父指标：盈亏平衡点（`breakEvenPoint`），归属费用组（`isGroup: true`，`layout: vertical`）。
- 费用组兄弟指标：员工工资（`storeTotalSalary`）、店铺水电费（`waterRent`）、门店其他支出（`storeOtherFee`）。
- 报告章节：盈亏平衡点费用拆解章节。

## 下钻子指标

无子指标。租金和物业管理费为叶子指标，不参与进一步下钻。

## 边界与禁放规则

- 租金和物业管理费仅出现在盈亏平衡点费用组中，不得放入其他指标组。
- 租金和物业管理费不得与门店净利润、坪效、人效等非费用类指标放在同一表格中混排。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。