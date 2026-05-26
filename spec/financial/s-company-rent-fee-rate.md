---
id: financial-s-company-rent-fee-rate
kind: spec
domain: financial
title: 租金费率指标详情
tags:
  - report
  - metric
  - financial-report
  - companyRentFeeRate
  - 租金费率
match:
  keywords:
    - 租金费率
    - 租金费率指标
    - 租金费率详情
    - companyRentFeeRate
---

# 租金费率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyRentFeeRate --full`

## 基本信息
| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 租金费率 |
| 指标英文 code | `companyRentFeeRate` |
| 业务定义 | 租金费用额占公司收入的占比 |
| 统计逻辑 | 无 |
| 业务环节 | 无 |
| 关联金额子指标 | `companyRentFee`（租金费额） |

## 指标定位
- 公司报表 `/report/4` 中费率（`companyTotalFeeRate`）的子指标
- 所属维度：费用管控维度 > 分项费用表现
- 关联金额子指标 `companyRentFee`（租金费额），可配合查询以获得金额维度的明细
- 固定拆解链路：`费率 -> 租金费率`

## 下钻子指标
该指标为叶子指标，无子指标。

关联金额子指标 `companyRentFee`（租金费额），可独立查询。

## 边界与禁放规则
- 所有数值来自 CLI 输出
- 公司报表无品类维度
- 归入费用管控维度 > 分项费用表现指标组，不得放入收入结构或毛利贡献章节
- 禁止传入 `--category-type` 或 `--category`
- 只支持周、月时间粒度，禁止使用日维度