---
id: financial-s-company-allowance-fee-rate
kind: spec
domain: financial
title: 补贴费用率指标详情
tags:
  - report
  - metric
  - financial-report
  - companyAllowanceFeeRate
  - 补贴费用率
match:
  keywords:
    - 补贴费用率
    - 补贴费用率指标
    - 补贴费用率详情
    - companyAllowanceFeeRate
---

# 补贴费用率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyAllowanceFeeRate --full`

## 基本信息
| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 补贴费用率 |
| 指标英文 code | `companyAllowanceFeeRate` |
| 业务定义 | 补贴费用占公司收入的占比 |
| 统计逻辑 | 无 |
| 业务环节 | 无 |
| 关联金额子指标 | `companyAllowanceFee`（补贴费用额） |

## 指标定位
- 公司报表 `/report/4` 中宣传促销补贴费率（`companyPromotionAllowanceFeeRate`）的子指标
- 所属维度：费用管控维度 > 宣传促销费用结构
- 关联金额子指标 `companyAllowanceFee`（补贴费用额），可配合查询以获得金额维度的明细
- 固定拆解链路：`费率 -> 宣传促销补贴费率 -> 补贴费用率`

## 下钻子指标
该指标为叶子指标，无子指标。

关联金额子指标 `companyAllowanceFee`（补贴费用额），可独立查询。

## 边界与禁放规则
- 所有数值来自 CLI 输出
- 公司报表无品类维度
- 归入费用管控维度 > 宣传促销费用结构指标组，不得放入收入结构或毛利贡献章节
- 禁止传入 `--category-type` 或 `--category`
- 只支持周、月时间粒度，禁止使用日维度