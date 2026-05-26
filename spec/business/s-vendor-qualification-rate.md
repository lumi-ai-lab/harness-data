---
id: business-s-vendor-qualification-rate
kind: spec
domain: business
title: 合格率指标详情
tags:
  - report
  - metric
  - business-report
  - vendorQualificationRate
  - 合格率
  - 供应链
match:
  keywords:
    - 合格率
    - 供应商合格率
    - 合格率指标
    - vendorQualificationRate
    - 履约质量
---

# 合格率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code vendorQualificationRate --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 供应商合格率 |
| 指标英文 code | `vendorQualificationRate` |
| 业务定义 | 供应商送货质量符合标准的次数占总送货次数的比例 |
| 统计逻辑 | 供应商合格次数 / 供应商送货次数 |
| 业务环节 | 采购环节 |

## 指标定位

- 合格率是经营分析 `/report/2` 中供应链维度"履约质量三率指标"的叶子指标。
- 所属维度：供应链维度。
- 报告章节：第五章 供应链维度深度拆解。
- 父指标：三率综合得分（`threeRateScore`），同属履约质量三率指标组的兄弟指标为准点率（`vendorIntimeRate`）和准确率（`vendorAccuracyRate`）。
- 合格率为叶子指标，无子指标。
- 固定拆解链路：`活跃供应商数 -> 三率综合得分 -> 合格率`（叶子，无子指标）。

## 下钻子指标

无子指标。合格率为履约质量三率指标组的叶子指标，其值由供应商合格次数与供应商送货次数的比率直接计算得出。

## 边界与禁放规则

- 合格率固定归入供应链维度（第五章），不得放入第三章（用户渗透）或第四章（品效）。
- 不得将合格率与品效维度指标（品效、商品订购渗透率、定价毛利率、售价价格指数及其子指标）交叉混排。
- 区域、品类、趋势证据只能用于解释合格率及其对上位三率综合得分的贡献，不得扩展为经营总览。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。
- 合格率作为三率之一的叶子指标，分析时需同步关注三率综合得分、准点率、准确率的联动表现。