---
id: financial-s-company-promotion-fee-rate
kind: spec
domain: financial
title: 宣传促销费率指标详情
tags:
  - report
  - metric
  - financial-report
  - companyPromotionFeeRate
  - 宣传促销费率
match:
  keywords:
    - 宣传促销费率
    - 宣传促销费率指标
    - 宣传促销费率详情
    - companyPromotionFeeRate
---

# 宣传促销费率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyPromotionFeeRate --full`

## 基本信息
| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 宣传促销费率 |
| 指标英文 code | `companyPromotionFeeRate` |
| 业务定义 | 宣传促销费额占公司收入的占比 |
| 统计逻辑 | 无 |
| 业务环节 | 无 |
| 关联金额子指标 | companyPromotionFee（宣传促销费额） |

## 指标定位
- 公司报表 /report/4 中宣传促销补贴费率的子指标。
- 所属维度：EBITDA 维度 > 费率 > 宣传促销补贴费率 > 宣传促销费率。
- 固定拆解链路：`费率 -> 宣传促销补贴费率 -> 宣传促销费率`。
- 本指标为叶子指标（费率型），有金额子指标（companyPromotionFee）可独立查询指标值。

## 下钻子指标
该指标为叶子指标，无子指标。

## 边界与禁放规则
- 所有数值来自 CLI 输出。
- 公司报表无品类维度。
- 金额子指标（companyPromotionFee）可独立查询指标值。
- 本指标为费率型叶子节点，不可进一步拆解为子费率。