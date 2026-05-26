---
id: financial-s-other-business-profit
kind: spec
domain: financial
title: 其他业务收支净额指标详情
tags:
  - report
  - metric
  - financial-report
  - otherBusinessProfit
  - 其他业务收支净额
match:
  keywords:
    - 其他业务收支净额
    - 其他业务收支净额指标
    - 其他业务收支净额详情
    - otherBusinessProfit
---

# 其他业务收支净额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code otherBusinessProfit --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 其他业务收支净额 |
| 指标英文 code | `otherBusinessProfit` |
| 业务定义 | 其他业务收支净额 |
| 统计逻辑 | 暂无详细统计逻辑说明 |
| 业务环节 | - |

## 指标定位

- 公司报表 `/report/4` 公司营业收入的子指标，属于收入结构维度下的叶子节点。
- 所属维度：收入结构维度。
- 报告章节：第四章 收入结构维度深度拆解。禁止放入第五章（毛利贡献维度）、第六章（费用管控维度）。
- 所属指标组：收入结构拆解与业务表现。
- 固定拆解链路：`公司营业收入 -> 其他业务收支净额`。
- 若 CLI 未返回该指标数据，可省略该行。

## 下钻子指标

该指标为叶子指标，无子指标。

## 边界与禁放规则

- 本指标固定归入财务报告第四章（收入结构维度深度拆解），禁止放入第五章、第六章。
- 不得将本指标与毛利贡献维度指标（公司毛利额、供应链毛利额、直营店毛利额）混放。
- 不得将本指标与费用管控维度指标（费率、各项费用率）混放。
- 公司报表无品类维度，禁止传入 `--category-type` 或 `--category`。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略，不写缺失说明，不保留占位符。