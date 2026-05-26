---
id: financial-s-company-allowance-fee
kind: spec
domain: financial
title: 补贴费用额指标详情
tags:
  - report
  - metric
  - financial-report
  - companyAllowanceFee
  - 补贴费用额
match:
  keywords:
    - 补贴费用额
    - 补贴费用额指标
    - 补贴费用额详情
    - companyAllowanceFee
---

# 补贴费用额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyAllowanceFee --full`

## 基本信息
| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 补贴费用额 |
| 指标英文 code | `companyAllowanceFee` |
| 业务定义 | 用于给门店经营提供经营支持的补贴费用 |
| 统计逻辑 | 新店补贴费用+装修返利补贴费用+其他补贴费用 |
| 业务环节 | 无 |
| 关联金额子指标 | 无（本身为金额型指标） |

## 指标定位
- 公司报表 `/report/4` 中补贴费用率（`companyAllowanceFeeRate`）的金额子指标（subIndicator）
- 所属维度：费用管控维度 > 宣传促销费用结构
- 与 `companyAllowanceFeeRate`（补贴费用率）配套使用，一率一额
- 固定拆解链路：`费率 -> 宣传促销补贴费率 -> 补贴费用率 -> 补贴费用额(subIndicator)`

## 下钻子指标
该指标为叶子指标，无子指标。

本身为金额型指标，是 `companyAllowanceFeeRate`（补贴费用率）的金额形态。

## 边界与禁放规则
- 所有数值来自 CLI 输出
- 公司报表无品类维度
- 归入费用管控维度 > 宣传促销费用结构指标组，不得放入收入结构或毛利贡献章节
- 禁止传入 `--category-type` 或 `--category`
- 只支持周、月时间粒度，禁止使用日维度