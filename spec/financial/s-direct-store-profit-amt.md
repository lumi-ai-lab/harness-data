---
id: financial-s-direct-store-profit-amt
kind: spec
domain: financial
title: 直营店毛利额指标详情
tags:
  - report
  - metric
  - financial-report
  - directStoreProfitAmt
  - 直营店毛利额
match:
  keywords:
    - 直营店毛利额
    - 直营店毛利额指标
    - 直营店毛利额详情
    - directStoreProfitAmt
---

# 直营店毛利额指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code directStoreProfitAmt --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 直营店毛利额 |
| 指标英文 code | `directStoreProfitAmt` |
| 业务定义 | 直营店的门店毛利额，如果门店转让了，取统计周期内是直营店身份的时间进行统计 |
| 统计逻辑 | 销售额-(进货额+门店期初库存金额-门店期末库存金额) |
| 业务环节 | 销售经营 |

## 指标定位

- 公司报表 `/report/4` 公司毛利额的子指标，属于叶子节点（无下级子指标）。
- 所属维度：毛利贡献维度。
- 报告章节：第五章 毛利贡献维度深度拆解。禁止放入第四章（收入结构维度）、第六章（费用管控维度）。
- 所属指标组：分业务毛利表现。
- 固定拆解链路：`EBITDA -> 公司毛利额 -> 直营店毛利额`。
- 在 CLI 中以 lineType:dashed 形式显示，表示虚线连接的毛利分项。

## 下钻子指标

该指标为叶子指标，无子指标。

## 边界与禁放规则

- 直营店毛利额固定归入财务报告第五章（毛利贡献维度深度拆解），禁止放入第四章、第六章。
- 直营店毛利额作为公司毛利额的分项，只能出现在公司毛利额的下方，不可替代主指标。
- 不得将收入结构指标（公司营业收入、供应链收入、直营店收入等）放入本章节。
- 不得将费用管控指标放入本章节。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回则省略该行。
- 公司报表无品类维度，禁止传入 `--category-type` 或 `--category`。