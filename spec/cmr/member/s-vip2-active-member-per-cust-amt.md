---
id: member-s-vip2-active-member-per-cust-amt
kind: spec
domain: member
title: vip2活跃会员客单价指标详情
tags:
  - report
  - metric
  - user-report
  - vip2ActiveMemberPerCustAmt
  - vip2活跃会员客单价
match:
  keywords:
    - vip2活跃会员客单价
    - vip2活跃会员客单价指标
    - vip2活跃会员客单价详情
    - vip2ActiveMemberPerCustAmt
---

# vip2活跃会员客单价指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code vip2ActiveMemberPerCustAmt --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | vip2活跃会员客单价 |
| 指标英文 code | `vip2ActiveMemberPerCustAmt` |
| 业务定义 | 会员等级为vip2的活跃会员，他们产生的订单的平均销售额 |
| 统计逻辑 | vip2活跃会员销售额 / vip2活跃会员来客数 |
| 业务环节 | 用户规模与分层结构 |

## 指标定位

- vip2活跃会员客单价是用户报表 `/report/3` 中"用户规模与分层结构"维度的指标。
- 所属维度：用户规模与分层结构。
- 报告章节：第三章 用户规模与分层结构维度深度拆解。
- 所属指标组：会员分层活跃与价值指标。
- 父指标：vip2活跃会员数（`vip2ActiveMemberNum`）。
- 无子指标，为叶子指标。
- 模板结构：非核心指标，7 章模板（叶子指标）。

## 下钻子指标

无子指标，为叶子指标。

## 边界与禁放规则

- vip2活跃会员客单价不得放入第四章（会员价值与复购转化）或第五章（用户触达与渠道效率）。
- 用户报表不支持品类过滤；不输出品类排名、品类拖累或品类贡献。
- 区域支持下钻；未指定区域时固定为全国（不含港澳）。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。