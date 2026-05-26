---
id: business-s-vendor-intime-rate
kind: spec
domain: business
title: 准点率指标详情
tags:
  - report
  - metric
  - business-report
  - vendorIntimeRate
  - 供应链
  - 三率
match:
  keywords:
    - 准点率
    - 供应商准点率
    - vendorIntimeRate
    - 三率
    - 履约质量
    - on_time_rate
---

# 准点率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code vendorIntimeRate --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 供应商准点率 |
| 指标英文 code | `vendorIntimeRate` |
| 业务定义 | 供应商按时送货到仓库的次数占总送货次数的比例 |
| 统计逻辑 | 供应商准点次数 / 供应商送货次数 |
| 业务环节 | 采购环节 |
| 所属维度 | 供应链维度 |
| indicatorCode in contract | `on_time_rate` |

## 指标定位

- 准点率是经营分析 `/report/2` 中**供应链维度**的叶子指标，属于履约质量三率指标组。
- 父指标：三率综合得分（`threeRateScore`），同组指标：准确率（`vendorAccuracyRate`）、合格率（`vendorQualificationRate`）。
- 报告章节：第二章 核心指标总览 + 第五章 供应链维度深度拆解。
- 固定拆解链路：`活跃供应商数 -> 三率综合得分 -> 准点率`（叶子指标，无下级子指标）。
- 准点率是三率综合得分三个子项之一，反映供应商按时履约能力。

## 下钻子指标

无。准点率是叶子指标，不可再向下拆解。其子项"供应商准点次数"和"供应商送货次数"仅为计算拆解原子，不作为独立分析指标使用。

## 边界与禁放规则

- 准点率固定归入供应链维度（第五章），不得放入用户渗透章节（第三章）和品效章节（第四章）。
- 准确率、合格率、三率综合得分、活跃供应商数不得放入品效章节作为主指标行。
- 出库折让率固定归入品效定价毛利率拆解，不得放入供应链章节。
- 区域、品类、趋势证据只能用于解释准点率及其对三率综合得分的贡献，不得扩展为经营总览。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。