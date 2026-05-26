---
id: financial-s-company-profit
kind: spec
domain: financial
title: 公司毛利额指标详情
tags:
  - report
  - metric
  - financial-report
  - companyProfit
  - 公司毛利额
match:
  keywords:
    - 公司毛利额
    - 公司毛利额指标
    - 公司毛利额详情
    - companyProfit
---

# 公司毛利额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code companyProfit --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 公司毛利额 |
| 指标英文 code | `companyProfit` |
| 业务定义 | 公司毛利额 |
| 统计逻辑 | 暂无详细统计逻辑说明 |
| 业务环节 | - |

## 指标定位

- 公司报表 `/report/4` 的一级核心指标（showTable），是 EBITDA 的直接子指标。
- 所属维度：毛利贡献维度。
- 报告章节：第二章 核心指标总览、第五章 毛利贡献维度深度拆解。禁止放入第四章（收入结构维度）、第六章（费用管控维度）。
- 所属指标组：整体毛利表现。
- 固定拆解链路：`EBITDA -> 公司毛利额 -> 供应链毛利额 / 直营店毛利额`。

## 下钻子指标

| 层级 | 指标 | code | 所属指标组 |
| :--- | :--- | :--- | :--- |
| 一级子指标 | 供应链毛利额(财务) | `financeScmProfit` | 分业务毛利表现 |
| 一级子指标 | 直营店毛利额 | `directStoreProfitAmt` | 分业务毛利表现 |

## 边界与禁放规则

- 公司毛利额固定归入财务报告第五章（毛利贡献维度深度拆解），禁止放入第四章、第六章。
- 收入结构指标（公司营业收入、供应链收入、直营店收入、品牌管理&加盟费、其他业务收支净额）不得放入本章节。
- 费用管控指标（费率、各项费用率）不得放入本章节。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出。
- 公司报表无品类维度，禁止传入 `--category-type` 或 `--category`。
- 供应链毛利额、直营店毛利额在 CLI 中以 lineType:dashed 形式显示，表示它们是虚线连接的子项。