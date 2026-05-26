---
id: business-s-promotion-discount-rate
kind: spec
domain: business
title: 促销折扣率指标详情
tags:
  - report
  - metric
  - business-report
  - promotionDiscountRate
  - 促销折扣率
match:
  keywords:
    - 促销折扣率
    - 促销折扣率指标
    - 促销折扣率详情
    - promotionDiscountRate
---

# 促销折扣率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code promotionDiscountRate --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 促销折扣率 |
| 指标英文 code | `promotionDiscountRate` |
| 业务定义 | 促销折扣额占原价销售额的比例 |
| 统计逻辑 | 促销折扣额/原价销售额 |
| 业务环节 | 销售经营,全链路 |

## 指标定位

- 促销折扣率是定价毛利率（prePriceProfitRate）的子指标，属于品效维度下的定价与折扣策略类叶子指标。
- 所属维度：品效维度。
- 报告章节：第四章 品效维度深度拆解。
- 固定拆解链路：`品效 -> 定价毛利率 -> 促销折扣率`。

## 下钻子指标

该指标为叶子指标，无子指标。

## 边界与禁放规则

- 不得放入第三章（用户渗透）、第五章（供应链）。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。