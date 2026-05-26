---
id: member-s-regular-active-member-per-cust-amt
kind: spec
domain: member
title: 普通活跃会员客单价指标详情
tags:
  - report
  - metric
  - user-report
  - regularActiveMemberPerCustAmt
  - 普通活跃会员客单价
match:
  keywords:
    - 普通活跃会员客单价
    - 普通活跃会员客单价指标
    - 普通活跃会员客单价详情
    - regularActiveMemberPerCustAmt
---

# 普通活跃会员客单价指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code regularActiveMemberPerCustAmt --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 普通活跃会员客单价 |
| 指标英文 code | `regularActiveMemberPerCustAmt` |
| 业务定义 | 会员等级为普通会员的活跃会员，他们产生的订单的平均销售额 |
| 统计逻辑 | 普通活跃会员销售额 / 普通活跃会员来客数 |
| 业务环节 | 用户运营 |

## 指标定位

- 普通活跃会员客单价是用户运营 `/report/3` 普通活跃会员数的子指标，属于用户规模与分层结构维度。
- 所属维度：用户规模与分层结构维度。
- 报告章节：第三章 用户规模与分层结构维度深度拆解。
- 指标组：会员分层活跃与价值指标。
- 固定拆解链路：`活跃用户数 -> 普通活跃会员数 -> 普通活跃会员客单价`。

## 下钻子指标

该指标为叶子指标，无子指标。

## 边界与禁放规则

- 用户报表不支持品类过滤；不输出品类排名、品类拖累或品类贡献。
- 普通活跃会员客单价归入用户规模与分层结构维度，固定放入第三章，不得放入第四章（会员价值与复购转化）和第五章（用户触达与渠道效率）。
- 该指标为普通活跃会员数的质量指标，在报告中紧跟普通活跃会员消费频次展示。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。
- 任何指标只能放入其对应维度的主章节，禁止跨维度混放。