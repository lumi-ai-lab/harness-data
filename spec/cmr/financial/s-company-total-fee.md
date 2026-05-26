---
id: financial-s-company-total-fee
kind: spec
domain: financial
title: 总费用额指标详情
tags:
  - report
  - metric
  - financial-report
  - companyTotalFee
  - 总费用额
  - 费额
match:
  keywords:
    - 总费用额
    - 费额
    - 总费用额指标
    - 总费用额详情
    - companyTotalFee
---

# 总费用额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyTotalFee --full`

## 基本信息
| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 费额 |
| 指标英文 code | `companyTotalFee` |
| 业务定义 | 公司总的费用支出金额 |
| 统计逻辑 | 宣传促销补贴费额+物流费额+租金费额+人员费额+其他费额 |
| 业务环节 | 无 |

## 指标定位
- 公司报表 /report/4 中费率的金额子指标（subIndicator of companyTotalFeeRate）。
- 所属维度：EBITDA 维度 > 费率。
- 固定拆解链路：`费率 -> 额`。

## 下钻子指标
| 子指标 | indicatorCode | 说明 |
| :--- | :--- | :--- |
| 宣传促销补贴费额 | companyPromotionAllowanceFee | 宣传促销费用额+补贴费用额 |
| 运输费额 | companyLogisticsFee | 物流运输费用金额 |
| 租金费额 | companyRentFee | 租金费用金额 |
| 人员费额 | companyStaffFee | 人员费用金额 |
| 其他费额 | companyOtherFee | 其他费用金额 |

## 边界与禁放规则
- 所有数值来自 CLI 输出。
- 公司报表无品类维度。
- 金额子指标可独立查询指标值。
- 本指标是费率（companyTotalFeeRate）的 subIndicator，不可单独作为费控维度主指标。