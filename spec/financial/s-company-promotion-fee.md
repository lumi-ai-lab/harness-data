---
id: financial-s-company-promotion-fee
kind: spec
domain: financial
title: 宣传促销费额指标详情
tags:
  - report
  - metric
  - financial-report
  - companyPromotionFee
  - 宣传促销费额
match:
  keywords:
    - 宣传促销费额
    - 宣传促销费额指标
    - 宣传促销费额详情
    - companyPromotionFee
---

# 宣传促销费额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyPromotionFee --full`

## 基本信息
| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 宣传促销费额 |
| 指标英文 code | `companyPromotionFee` |
| 业务定义 | 无 |
| 统计逻辑 | 次日达电商营销费+到家电商营销费+其他宣传促销费 |
| 业务环节 | 无 |

## 指标定位
- 公司报表 /report/4 中宣传促销费率（companyPromotionFeeRate）的金额子指标。
- 所属维度：EBITDA 维度 > 费率 > 宣传促销补贴费率 > 宣传促销费率。
- 固定拆解链路：`费率 -> 宣传促销补贴费率 -> 宣传促销费率 -> 宣传促销费额`。
- 本指标为叶子指标（金额型），无下级子指标，仅作为父指标 companyPromotionFeeRate 的 amount subIndicator。

## 下钻子指标
该指标为叶子指标，无子指标。

## 边界与禁放规则
- 所有数值来自 CLI 输出。
- 公司报表无品类维度。
- 金额子指标可独立查询指标值。
- 作为 subIndicator 不可脱离父指标 companyPromotionFeeRate 单独作为主维度指标。