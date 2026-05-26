---
id: financial-s-company-total-fee-rate
kind: spec
domain: financial
title: 费率指标详情
tags:
  - report
  - metric
  - financial-report
  - companyTotalFeeRate
  - 费率
match:
  keywords:
    - 费率
    - 费率指标
    - 费率详情
    - companyTotalFeeRate
    - 公司费用率
---

# 费率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyTotalFeeRate --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 费率 |
| 指标英文 code | `companyTotalFeeRate` |
| 业务定义 | 公司总的费用支出占公司收入的占比 |
| 统计逻辑 | 暂无详细统计逻辑说明 |
| 业务环节 | - |

## 指标定位

- 公司报表 `/report/4` 的一级核心指标（showTable），是 EBITDA 的直接子指标。
- 所属维度：费用管控维度。
- 报告章节：第二章 核心指标总览、第六章 费用管控维度深度拆解。禁止放入第四章（收入结构维度）、第五章（毛利贡献维度）。
- 所属指标组：整体费用表现。
- 固定拆解链路：`EBITDA -> 费率 -> 各项费用率（宣传促销补贴费率、运输费率、租金费率、人员费用率、其他费用率）`。
- 费率指标有配套的金额 subIndicator：`companyTotalFee`（总费用额），两者需联动显示。

## 下钻子指标

| 层级 | 指标 | code | 所属指标组 |
| :--- | :--- | :--- | :--- |
| 一级子指标 | 宣传促销补贴费率 | `companyPromotionAllowanceFeeRate` | 分项费用表现 |
| 一级子指标 | 运输费率 | `companyLogisticsFeeRate` | 分项费用表现 |
| 一级子指标 | 租金费率 | `companyRentFeeRate` | 分项费用表现 |
| 一级子指标 | 人员费用率 | `companyStaffFeeRate` | 分项费用表现 |
| 一级子指标 | 其他费用率 | `companyOtherFeeRate` | 分项费用表现 |

### SubIndicator 清单

| subIndicator 指标 | code | 说明 |
| :--- | :--- | :--- |
| 总费用额 | `companyTotalFee` | 费率的金额口径，与费率配套显示 |

## 边界与禁放规则

- 费率固定归入财务报告第六章（费用管控维度深度拆解），禁止放入第四章、第五章。
- 收入结构指标不得放入本章节。
- 毛利贡献指标不得放入本章节。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出。
- 公司报表无品类维度，禁止传入 `--category-type` 或 `--category`。
- 各项费用率及其对应费用额需在分项费用表现指标组中成对展示。