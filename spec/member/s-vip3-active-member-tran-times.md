---
id: member-s-vip3-active-member-tran-times
kind: spec
domain: member
title: vip3活跃会员消费频次指标详情
tags:
  - report
  - metric
  - user-report
  - vip3ActiveMemberTranTimes
  - vip3活跃会员消费频次
match:
  keywords:
    - vip3活跃会员消费频次
    - vip3活跃会员消费频次指标
    - vip3活跃会员消费频次详情
    - vip3ActiveMemberTranTimes
---

# vip3活跃会员消费频次指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code vip3ActiveMemberTranTimes --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | vip3活跃会员消费频次 |
| 指标英文 code | `vip3ActiveMemberTranTimes` |
| 业务定义 | 会员等级为vip3的活跃会员，平均每位会员在统计周期内的消费次数 |
| 统计逻辑 | 统计周期内，vip3活跃会员来客数 / vip3活跃会员消费人数 |
| 数据来源 | 用户报表 `/report/3`（`qdm-cmr-cli report user`） |

## 指标定位

- vip3活跃会员消费频次是用户报表 `/report/3` 中vip3活跃会员数的下游叶子指标。
- 所属维度：用户规模与分层结构。
- 报告章节：第三章 用户规模与分层结构深度拆解。
- 父指标：vip3活跃会员数（`vip3ActiveMemberNum`）。
- 无子指标，为叶子指标。
- 同层级关联指标：vip3活跃会员客单价（`vip3ActiveMemberPerCustAmt`）。

## 下钻子指标

无。vip3活跃会员消费频次为叶子指标，无下钻子指标。

## 边界与禁放规则

- vip3活跃会员消费频次固定归入"用户规模与分层结构"维度（第三章），禁止放入第四章（用户价值与复购转化）和第五章（用户触达与渠道效率）。
- 不得作为经营分析 `/report/2` 的指标行。
- vip3活跃会员消费频次不支持下钻品类维度分析（用户报表不支持品类过滤）。
- 区域、趋势证据只能用于解释vip3活跃会员消费频次的表现，不得扩展为用户总览报告。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。