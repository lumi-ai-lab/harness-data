---
id: financial-s-company-rent-fee
kind: spec
domain: financial
title: 租金费额指标详情
tags:
  - report
  - metric
  - financial-report
  - companyRentFee
  - 租金费额
match:
  keywords:
    - 租金费额
    - 租金费额指标
    - 租金费额详情
    - companyRentFee
---

# 租金费额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyRentFee --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 租金费额 |
| 指标英文 code | `companyRentFee` |
| 业务定义 | 公司总额租金支出情况 |
| 统计逻辑 | 供应链端租金+运营端租金+总部职能租金 |
| 业务环节 | 费用管控 |
| 关联金额子指标 | 无（金额型叶子指标） |

## 指标定位

- 公司报表 /report/4 中租金费率的金额子指标
- 所属维度：EBITDA 维度 > 费率 > 租金费率
- 金额型叶子指标：无子指标，关联父指标 `companyRentFeeRate`（租金费率）
- 固定拆解链路：`费率 -> 租金费率 -> 租金费额`

## 下钻子指标

该指标为叶子指标，无子指标。可通过关联的父指标 `companyRentFeeRate`（租金费率）查询费率表现。

## 边界与禁放规则

- 所有数值来自 CLI 输出
- 公司报表无品类维度
- 租金费额仅支持周、月时间粒度，禁止传入 `--date` 使用日维度
- 租金费额归入费用管控维度，禁止跨维度放入收入结构或毛利贡献章节