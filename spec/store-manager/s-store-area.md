---
id: store-s-store-area
kind: spec
domain: store
title: 门店面积指标详情
tags:
  - report
  - metric
  - store-report
  - storeArea
  - 门店面积
match:
  keywords:
    - 门店面积
    - 门店面积指标
    - 门店面积详情
    - storeArea
---

# 门店面积指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code storeArea --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 门店面积 |
| 指标英文 code | `storeArea` |
| 业务定义 | 门店营业面积（平方米） |
| 统计逻辑 | 统计周期内门店实际营业面积 |
| 业务环节 | 门店管理 |

## 指标定位

- 门店面积是门店管理 `/report/1` 中坪效（`areaEffective`）的下钻子指标。
- 所属维度：门店管理维度。
- 父指标：坪效（`areaEffective`），坪效向上归属于门店净利润（`netProfit`）。
- 报告章节：坪效拆解章节。

## 下钻子指标

无子指标。门店面积为叶子指标，不参与进一步下钻。

## 边界与禁放规则

- 门店面积仅出现在坪效拆解章节中，不得单独作为主指标行放入其他章节。
- 门店面积不得与盈亏平衡点费用组指标混排在同一表格中。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。