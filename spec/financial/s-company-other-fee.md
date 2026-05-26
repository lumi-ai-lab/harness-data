---
id: financial-s-company-other-fee
kind: spec
domain: financial
title: 其他费用额指标详情
tags:
  - report
  - metric
  - financial-report
  - companyOtherFee
  - 其他费用额
match:
  keywords:
    - 其他费用额
    - 其他费用额指标
    - 其他费用额详情
    - companyOtherFee
---

# 其他费用额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyOtherFee --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 其他费用额 |
| 指标英文 code | `companyOtherFee` |
| 业务定义 | 除物流、租金、人员费用、宣传促销费、补贴费之外的其他费用 |
| 统计逻辑 | 无 |
| 业务环节 | 费用管控 |
| 关联金额子指标 | 无（金额型叶子指标） |

## 指标定位

- 公司报表 /report/4 中其他费用率的金额子指标
- 所属维度：EBITDA 维度 > 费率 > 其他费用率 > 其他费用额
- 金额型叶子指标：无子指标，关联父指标 `companyOtherFeeRate`（其他费用率）
- 固定拆解链路：`费率 -> 其他费用率 -> 其他费用额`

## 下钻子指标

该指标为叶子指标，无子指标。可通过关联的父指标 `companyOtherFeeRate`（其他费用率）查询费率表现。

## 边界与禁放规则

- 所有数值来自 CLI 输出
- 公司报表无品类维度
- 其他费用额仅支持周、月时间粒度，禁止传入 `--date` 使用日维度
- 其他费用额归入费用管控维度，禁止跨维度放入收入结构或毛利贡献章节