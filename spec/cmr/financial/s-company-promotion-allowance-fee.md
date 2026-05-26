---
id: financial-s-company-promotion-allowance-fee
kind: spec
domain: financial
title: 宣传促销补贴费额指标详情
tags:
  - report
  - metric
  - financial-report
  - companyPromotionAllowanceFee
  - 宣传促销补贴费额
match:
  keywords:
    - 宣传促销补贴费额
    - 宣传促销补贴费额指标
    - 宣传促销补贴费额详情
    - companyPromotionAllowanceFee
---

# 宣传促销补贴费额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyPromotionAllowanceFee --full`

## 基本信息
| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 宣传促销补贴费额 |
| 指标英文 code | `companyPromotionAllowanceFee` |
| 业务定义 | 用于支持门店经营及门店营销的费用额 |
| 统计逻辑 | 宣传促销费用额+补贴费用额 |
| 业务环节 | 无 |

## 指标定位
- 公司报表 /report/4 中宣传促销补贴费率（companyPromotionAllowanceFeeRate）的金额子指标。
- 所属维度：EBITDA 维度 > 费率 > 宣传促销补贴费率。
- 固定拆解链路：`费率 -> 宣传促销补贴费率 -> 宣传促销补贴费额`。
- 本指标为叶子指标（金额型），无下级子指标，仅作为父指标 companyPromotionAllowanceFeeRate 的 amount subIndicator。

## 下钻子指标
该指标为叶子指标，无子指标。

## 边界与禁放规则
- 所有数值来自 CLI 输出。
- 公司报表无品类维度。
- 金额子指标可独立查询指标值。
- 作为 subIndicator 不可脱离父指标 companyPromotionAllowanceFeeRate 单独作为主维度指标。