---
id: financial-s-company-business-income
kind: spec
domain: financial
title: 公司营业收入指标详情
tags:
  - report
  - metric
  - financial-report
  - companyBusinessIncome
  - 公司营业收入
match:
  keywords:
    - 公司营业收入
    - 公司营业收入指标
    - 公司营业收入详情
    - 营业收入
    - companyBusinessIncome
---

# 公司营业收入指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyBusinessIncome --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 公司营业收入 |
| 指标英文 code | `companyBusinessIncome` |
| 业务定义 | 无 |
| 统计逻辑 | -加盟费用收入+供应链收入+直营门店收入+品牌使用费收入-直营门店成本+职能部门收入+（-其他收入-其他支出） |
| 业务环节 | 无 |

## 指标定位

- 公司营业收入是公司报表 `/report/4` 中 EBITDA 的子指标。
- 所属维度：EBITDA 维度。
- 在指标树中标记为 showTable，作为表格展示节点。
- 固定拆解链路：`EBITDA -> 公司营业收入 -> 供应链收入(财务)、直营店收入、品牌管理&加盟费、其他业务收支净额`。

## 下钻子指标

| 层级 | 指标 | code | 说明 |
| :--- | :--- | :--- | :--- |
| 一级子指标 | 供应链收入(财务) | `financeScmIncome` | 叶子指标 |
| 一级子指标 | 直营店收入 | `directStoreIncome` | 叶子指标 |
| 一级子指标 | 品牌管理&加盟费 | `manageFranchiseFee` | 叶子指标 |
| 一级子指标 | 其他业务收支净额 | `otherBusinessProfit` | 叶子指标 |

## 边界与禁放规则

- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。
- 公司报表无品类维度，不引用品类相关数据。
- 公司营业收入仅拆解为公司层面的四大收入来源，不引入门店层级经营指标。