---
id: financial-s-company-staff-fee-rate
kind: spec
domain: financial
title: 人员费用率指标详情
tags:
  - report
  - metric
  - financial-report
  - companyStaffFeeRate
  - 人员费用率
match:
  keywords:
    - 人员费用率
    - 人员费用率指标
    - 人员费用率详情
    - companyStaffFeeRate
---

# 人员费用率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyStaffFeeRate --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 人员费用率 |
| 指标英文 code | `companyStaffFeeRate` |
| 业务定义 | 人员费用占公司收入的占比 |
| 统计逻辑 | 无 |
| 业务环节 | 费用管控 |
| 关联金额子指标 | `companyStaffFee`（人员费用额） |

## 指标定位

- 公司报表 /report/4 中费率的子指标
- 所属维度：EBITDA 维度 > 费率 > 人员费用率
- 关联金额子指标 `companyStaffFee`（人员费用额），可独立查询金额水分项
- 固定拆解链路：`费率 -> 人员费用率 -> 人员费用额`

## 下钻子指标

该指标为叶子指标，无子指标。关联金额子指标 `companyStaffFee`（人员费用额），可独立查询金额明细。

## 边界与禁放规则

- 所有数值来自 CLI 输出
- 公司报表无品类维度
- 人员费用率仅支持周、月时间粒度，禁止传入 `--date` 使用日维度
- 人员费用率归入费用管控维度，禁止跨维度放入收入结构或毛利贡献章节