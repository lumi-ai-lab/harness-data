---
id: financial-s-finance-scm-income
kind: spec
domain: financial
title: 供应链收入(财务)指标详情
tags:
  - report
  - metric
  - financial-report
  - financeScmIncome
  - 供应链收入
match:
  keywords:
    - 供应链收入
    - 供应链收入指标
    - 供应链收入详情
    - 财务供应链收入
    - financeScmIncome
---

# 供应链收入(财务)指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code financeScmIncome --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 供应链收入(财务) |
| 指标英文 code | `financeScmIncome` |
| 业务定义 | 供应链收入(财务) |
| 统计逻辑 | 无 |
| 业务环节 | 无 |

## 指标定位

- 供应链收入(财务)是公司报表 `/report/4` 中公司营业收入的子指标。
- 所属维度：EBITDA 维度。
- 固定拆解链路：`EBITDA -> 公司营业收入 -> 供应链收入(财务)`。

## 下钻子指标

该指标为叶子指标，无子指标。

## 边界与禁放规则

- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。
- 公司报表无品类维度，不引用品类相关数据。
- 供应链收入(财务)聚焦公司财务口径的供应链业务收入，不拆解到门店层面。