---
id: financial-s-company-logistics-fee
kind: spec
domain: financial
title: 物流费额指标详情
tags:
  - report
  - metric
  - financial-report
  - companyLogisticsFee
  - 物流费额
  - 运输费额
match:
  keywords:
    - 物流费额
    - 物流费额指标
    - 物流费额详情
    - 运输费额
    - 运输费额指标
    - companyLogisticsFee
---

# 物流费额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyLogisticsFee --full`

## 基本信息
| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 物流费额 |
| 指标英文 code | `companyLogisticsFee` |
| 业务定义 | 供应链出库仓配到店产生的物流费用，对应财报的供应链-物流费 |
| 统计逻辑 | 无 |
| 业务环节 | 无 |
| 关联金额子指标 | 无（本身为金额型指标） |

## 指标定位
- 公司报表 `/report/4` 中运输费率（`companyLogisticsFeeRate`）的金额子指标（subIndicator）
- 所属维度：费用管控维度 > 分项费用表现
- 与 `companyLogisticsFeeRate`（物流费率/运输费率）配套使用，一率一额
- 固定拆解链路：`费率 -> 运输费率 -> 运输费额(subIndicator)`

## 下钻子指标
该指标为叶子指标，无子指标。

本身为金额型指标，是 `companyLogisticsFeeRate`（物流费率）的金额形态。

## 边界与禁放规则
- 所有数值来自 CLI 输出
- 公司报表无品类维度
- 归入费用管控维度 > 分项费用表现指标组，不得放入收入结构或毛利贡献章节
- 禁止传入 `--category-type` 或 `--category`
- 只支持周、月时间粒度，禁止使用日维度