---
id: financial-s-ebitda-company-profit
kind: spec
domain: financial
title: EBITDA指标详情
tags:
  - report
  - metric
  - financial-report
  - ebitdaCompanyProfit
  - EBITDA
  - 税息前利润
match:
  keywords:
    - EBITDA
    - EBITDA指标
    - EBITDA详情
    - 税息前利润
    - 税息前利润指标
    - ebitdaCompanyProfit
---

# EBITDA指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code ebitdaCompanyProfit --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 税息前利润 |
| 指标英文 code | `ebitdaCompanyProfit` |
| 业务定义 | 公司的税息前利润 |
| 统计逻辑 | 公司其他收入+门店业务毛利-费用总额-折旧及摊销 |
| 业务环节 | 财务结算 |

## 指标定位

- EBITDA 是公司报表 `/report/4` 的一级核心指标。
- 所属维度：EBITDA 维度。
- 在指标树中标记为 showTable，作为表格展示节点。
- 固定拆解链路：`EBITDA -> 公司营业收入、公司毛利额、费率 -> 供应链收入、直营店收入、品牌管理&加盟费、其他业务收支净额、供应链毛利额、直营店毛利额、宣传促销补贴费率、运输费率、租金费率、人员费用率、其他费用率`。

## 下钻子指标

| 层级 | 指标 | code | 说明 |
| :--- | :--- | :--- | :--- |
| 一级子指标 | 公司营业收入 | `companyBusinessIncome` | showTable，含子指标 |
| 一级子指标 | 公司毛利额 | `companyProfit` | showTable，含子指标 |
| 一级子指标 | 费率 | `companyTotalFeeRate` | showTable，含子指标 |

公司营业收入和公司毛利额是 EBITDA 的构成部分，费率（总费用率）反映费用对 EBITDA 的侵蚀程度。三级子指标中，`companyPromotionFee`、`companyAllowanceFee`、`companyPromotionFee`（宣传促销费额）、`companyLogisticsFee`、`companyRentFee`、`companyStaffFee`、`companyOtherFee` 分别是各费率的金额子指标（subIndicator）。

## 边界与禁放规则

- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。
- 公司报表无品类维度，不引用品类相关数据。
- EBITDA 的拆解聚焦公司层面的收入、毛利、费用三大板块，不引入门店层面经营指标（如品效、客数等）。
- `financeScmProfit` 和 `directStoreProfitAmt` 在公司毛利额下的线型为 dashed，作为辅助参考线。