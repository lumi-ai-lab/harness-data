---
id: store-s-area-effective
kind: spec
domain: store
title: 坪效指标详情
tags:
  - report
  - metric
  - store-report
  - areaEffective
  - 坪效
match:
  keywords:
    - 坪效
    - 坪效指标
    - 坪效详情
    - areaEffective
---

# 坪效指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code areaEffective --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 坪效 |
| 指标英文 code | `areaEffective` |
| 业务定义 | 门店每平方米面积的销售额产出 |
| 统计逻辑 | 门店销售额 / 门店面积 |
| 业务环节 | 门店管理 |

## 指标定位

- 坪效是门店管理 `/report/1` 中门店净利润（`netProfit`）的下钻子指标之一。
- 所属维度：门店管理维度。
- 父指标：门店净利润（`netProfit`）。
- 固定拆解链路：`坪效 -> 门店面积（storeArea）`。
- 报告章节：门店净利润深度拆解章节。

## 下钻子指标

| 层级 | 指标 | code | 所属指标组 |
| :--- | :--- | :--- | :--- |
| 一级子指标 | 门店面积 | `storeArea` | 坪效拆解 |

## 边界与禁放规则

- 坪效归入门店盈利与运营效率，不得放入门店规模与健康度章节。
- 坪效的拆解仅包含门店面积，不得扩展为经营总览报告。
- 区域、趋势证据只能用于解释坪效及其下钻链路，不得扩展为其他指标分析。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。