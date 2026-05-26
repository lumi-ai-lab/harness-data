---
id: financial-s-manage-franchise-fee
kind: spec
domain: financial
title: 品牌管理&加盟费指标详情
tags:
  - report
  - metric
  - financial-report
  - manageFranchiseFee
  - 品牌管理&加盟费
match:
  keywords:
    - 品牌管理&加盟费
    - 品牌管理加盟费
    - 管理加盟费指标
    - 管理加盟费详情
    - manageFranchiseFee
---

# 品牌管理&加盟费指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code manageFranchiseFee --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 管理&加盟费 |
| 指标英文 code | `manageFranchiseFee` |
| 业务定义 | 品牌使用费+加盟费收入 |
| 统计逻辑 | 品牌使用费+加盟费收入 |
| 业务环节 | 无 |

## 指标定位

- 品牌管理&加盟费是公司报表 `/report/4` 中公司营业收入的子指标。
- 所属维度：EBITDA 维度。
- 固定拆解链路：`EBITDA -> 公司营业收入 -> 品牌管理&加盟费`。

## 下钻子指标

该指标为叶子指标，无子指标。

## 边界与禁放规则

- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。
- 公司报表无品类维度，不引用品类相关数据。
- 品牌管理&加盟费由品牌使用费和加盟费收入两部分构成，反映品牌和加盟体系的变现能力。