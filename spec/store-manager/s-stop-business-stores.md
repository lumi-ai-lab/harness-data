---
id: store-s-stop-business-stores
kind: spec
domain: store
title: 停业门店数指标详情
tags:
  - report
  - metric
  - store-report
  - stopBusinessStores
  - 停业门店数
match:
  keywords:
    - 停业门店数
    - 停业门店数指标
    - 停业门店数详情
    - stopBusinessStores
---

# 停业门店数指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code stopBusinessStores --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 停业门店数 |
| 指标英文 code | `stopBusinessStores` |
| 业务定义 | 当前处于停业状态的门店数量，反映短期停业风险 |
| 统计逻辑 | 统计当前处于停业状态的门店总数 |
| 业务环节 | 门店管理环节 |

## 指标定位

- 停业门店数是门店管理 `/report/1` 的门店规模与健康度维度下的叶子指标。
- 所属维度：门店规模与健康度。
- 报告章节：第三章 门店规模与健康度维度深度拆解。
- 归属链路：`营业门店数 -> 停业门店数`。
- 父指标：`stores`（营业门店数）。

## 父子关系

| 层级 | 指标 | code | 所属指标组 |
| :--- | :--- | :--- | :--- |
| 父指标 | 营业门店数 | `stores` | 门店规模与净增长指标 |
| 当前 | 停业门店数 | `stopBusinessStores` | 门店规模与净增长指标 |

## 边界与禁放规则

- 停业门店数归入门店规模与净增长指标组，不得放入门店盈利与运营效率章节（第四章）。
- 品类口径固定为全品类，不做品类下钻。
- 区域支持下钻；未指定区域时固定为全国（不含港澳）。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。