---
id: financial-s-company-logistics-fee-rate
kind: spec
domain: financial
title: 物流费率指标详情
tags:
  - report
  - metric
  - financial-report
  - companyLogisticsFeeRate
  - 物流费率
  - 运输费率
match:
  keywords:
    - 物流费率
    - 物流费率指标
    - 物流费率详情
    - 运输费率
    - 运输费率指标
    - companyLogisticsFeeRate
---

# 物流费率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyLogisticsFeeRate --full`

## 基本信息
| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 物流费率 |
| 指标英文 code | `companyLogisticsFeeRate` |
| 业务定义 | 物流费占公司收入的占比 |
| 统计逻辑 | 物流费 / 出库总额 |
| 业务环节 | 无 |
| 关联金额子指标 | `companyLogisticsFee`（物流费额） |

## 指标定位
- 公司报表 `/report/4` 中费率（`companyTotalFeeRate`）的子指标
- 所属维度：费用管控维度 > 分项费用表现
- 关联金额子指标 `companyLogisticsFee`（物流费额），可配合查询以获得金额维度的明细
- 固定拆解链路：`费率 -> 运输费率`

## 下钻子指标
该指标为叶子指标，无子指标。

关联金额子指标 `companyLogisticsFee`（物流费额），可独立查询。

## 边界与禁放规则
- 所有数值来自 CLI 输出
- 公司报表无品类维度
- 归入费用管控维度 > 分项费用表现指标组，不得放入收入结构或毛利贡献章节
- 禁止传入 `--category-type` 或 `--category`
- 只支持周、月时间粒度，禁止使用日维度