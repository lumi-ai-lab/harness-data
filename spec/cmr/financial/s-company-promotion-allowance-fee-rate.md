---
id: financial-s-company-promotion-allowance-fee-rate
kind: spec
domain: financial
title: 宣传促销补贴费率指标详情
tags:
  - report
  - metric
  - financial-report
  - companyPromotionAllowanceFeeRate
  - 宣传促销补贴费率
match:
  keywords:
    - 宣传促销补贴费率
    - 宣传促销补贴费率指标
    - 宣传促销补贴费率详情
    - companyPromotionAllowanceFeeRate
---

# 宣传促销补贴费率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyPromotionAllowanceFeeRate --full`

## 基本信息
| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 宣传促销补贴费率 |
| 指标英文 code | `companyPromotionAllowanceFeeRate` |
| 业务定义 | 宣传促销费额占公司收入的占比 |
| 统计逻辑 | 无 |
| 业务环节 | 无 |
| 关联金额子指标 | companyPromotionAllowanceFee（宣传促销补贴费额） |

## 指标定位
- 公司报表 /report/4 中费率的子指标。
- 所属维度：EBITDA 维度 > 费率 > 宣传促销补贴费率。
- 固定拆解链路：`费率 -> 宣传促销补贴费率`。
- 本指标是费率（companyTotalFeeRate）的直接子指标，有金额子指标（companyPromotionAllowanceFee）可独立查询指标值。

## 下钻子指标
| 子指标 | indicatorCode | 说明 |
| :--- | :--- | :--- |
| 宣传促销费率 | companyPromotionFeeRate | 宣传促销费额占公司收入的占比（叶子指标） |
| 补贴费用率 | companyAllowanceFeeRate | 补贴费用额占公司收入的占比（叶子指标） |

## 边界与禁放规则
- 所有数值来自 CLI 输出。
- 公司报表无品类维度。
- 金额子指标（companyPromotionAllowanceFee）可独立查询指标值。
- 子指标（宣传促销费率、补贴费用率）为叶子节点，可进一步下钻其金额子指标。