---
id: financial-s-company-staff-fee
kind: spec
domain: financial
title: 人员费用额指标详情
tags:
  - report
  - metric
  - financial-report
  - companyStaffFee
  - 人员费用额
match:
  keywords:
    - 人员费用额
    - 人员费用额指标
    - 人员费用额详情
    - companyStaffFee
---

# 人员费用额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyStaffFee --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 人员费用额 |
| 指标英文 code | `companyStaffFee` |
| 业务定义 | 供应链人工（含劳务）+运营人工+总部员工的费用总额 |
| 统计逻辑 | 无 |
| 业务环节 | 费用管控 |
| 关联金额子指标 | 无（金额型叶子指标） |

## 指标定位

- 公司报表 /report/4 中人员费用率的金额子指标
- 所属维度：EBITDA 维度 > 费率 > 人员费用率 > 人员费用额
- 金额型叶子指标：无子指标，关联父指标 `companyStaffFeeRate`（人员费用率）
- 固定拆解链路：`费率 -> 人员费用率 -> 人员费用额`

## 下钻子指标

该指标为叶子指标，无子指标。可通过关联的父指标 `companyStaffFeeRate`（人员费用率）查询费率表现。

## 边界与禁放规则

- 所有数值来自 CLI 输出
- 公司报表无品类维度
- 人员费用额仅支持周、月时间粒度，禁止传入 `--date` 使用日维度
- 人员费用额归入费用管控维度，禁止跨维度放入收入结构或毛利贡献章节