---
id: financial-s-direct-store-income
kind: spec
domain: financial
title: 直营店收入指标详情
tags:
  - report
  - metric
  - financial-report
  - directStoreIncome
  - 直营店收入
match:
  keywords:
    - 直营店收入
    - 直营店收入指标
    - 直营店收入详情
    - directStoreIncome
---

# 直营店收入指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code directStoreIncome --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 直营店收入 |
| 指标英文 code | `directStoreIncome` |
| 业务定义 | 直营店收入 |
| 统计逻辑 | 无 |
| 业务环节 | 无 |

## 指标定位

- 直营店收入是公司报表 `/report/4` 中公司营业收入的子指标。
- 所属维度：EBITDA 维度。
- 固定拆解链路：`EBITDA -> 公司营业收入 -> 直营店收入`。

## 下钻子指标

该指标为叶子指标，无子指标。

## 边界与禁放规则

- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。
- 公司报表无品类维度，不引用品类相关数据。
- 直营店收入聚焦公司财务口径的直营门店业务收入，不拆解到单店或品类层面。