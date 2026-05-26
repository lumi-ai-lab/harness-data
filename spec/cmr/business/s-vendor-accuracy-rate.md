---
id: business-s-vendor-accuracy-rate
kind: spec
domain: business
title: 准确率指标详情
tags:
  - report
  - metric
  - business-report
  - vendorAccuracyRate
  - 准确率
  - 供应链
match:
  keywords:
    - 准确率
    - 准确率指标
    - 准确率详情
    - 供应商准确率
    - vendorAccuracyRate
    - 三率
    - 履约质量
---

# 准确率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code vendorAccuracyRate --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 供应商准确率 |
| 指标英文 code | `vendorAccuracyRate` |
| 业务定义 | 供应商送货数量符合入库标准的次数占总送货次数的比例 |
| 统计逻辑 | 供应商准确次数 / 供应商送货次数 |
| 业务环节 | 采购环节 |
| 报告中的 indicatorCode | `accuracy_rate` |

## 指标定位

- 准确率是经营分析 `/report/2` 中供应链维度的**叶子指标**，属于履约质量三率指标组（准确率、准点率、合格率），三率汇总为三率综合得分（`threeRateScore`）。
- 所属维度：供应链维度。
- 报告章节：第五章 供应链维度深度拆解。
- 固定拆解链路：`活跃供应商数 -> 三率综合得分 -> 准确率`（叶子指标，无子指标）。

## 下钻子指标

无子指标。准确率为叶子指标，统计逻辑为 `供应商准确次数 / 供应商送货次数`，不进一步拆解。

## 边界与禁放规则

- 准确率固定归入供应链维度（第五章），不得放入品效维度（第四章）和用户渗透维度（第三章）。
- 准确率是履约质量三率之一，与准点率（`vendorIntimeRate`）、合格率（`vendorQualificationRate`）同属一个指标组。
- 准确率的区域、品类、趋势证据只能用于解释供应链履约质量维度的表现，不得扩展为经营总览。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。