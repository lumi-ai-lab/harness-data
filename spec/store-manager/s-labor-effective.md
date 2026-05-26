---
id: store-s-labor-effective
kind: spec
domain: store
title: 人效指标详情
tags:
  - report
  - metric
  - store-report
  - laborEffective
  - 人效
match:
  keywords:
    - 人效
    - 人效指标
    - 人效详情
    - laborEffective
---

# 人效指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code laborEffective --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 人效 |
| 指标英文 code | `laborEffective` |
| 业务定义 | 门店单人均净利润贡献，反映门店人力投入的产出效率 |
| 统计逻辑 | 门店净利润 / 门店人数 |
| 业务环节 | 门店运营 |

## 指标定位

- 人效是门店管理 `/report/1` 一级核心指标门店净利润（`netProfit`）的下钻子指标。
- 所属维度：盈利效率维度。
- 报告章节：第三章 门店盈利效率深度拆解。
- 固定拆解链路：`门店净利润 -> 人效 -> 门店人数`。
- 所属指标组：盈利效率。

## 下钻子指标

| 层级 | 指标 | code | 所属指标组 |
| :--- | :--- | :--- | :--- |
| 一级子指标 | 门店人数 | `storeNum` | 盈利效率 |

## 边界与禁放规则

- 人效不得放入门店规模与健康度章节。
- 营业门店数、开店数、闭店数、停业门店数不得放入人效章节。
- 区域、趋势证据只能用于解释人效及其下钻链路，不得扩展为门店管理总览。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。