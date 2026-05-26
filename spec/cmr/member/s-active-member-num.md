---
id: member-s-active-member-num
kind: spec
domain: member
title: 活跃用户数指标详情
tags:
  - report
  - metric
  - user-report
  - activeMemberNum
  - 活跃用户数
match:
  keywords:
    - 活跃用户数
    - 活跃用户数指标
    - 活跃用户数详情
    - activeMemberNum
---

# 活跃用户数指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code activeMemberNum --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 活跃用户数 |
| 指标英文 code | `activeMemberNum` |
| 业务定义 | 统计时间内，会员生命周期属于成长期+成熟期+衰退期的会员数 |
| 统计逻辑 | sum(成长期会员数 + 成熟期会员数 + 衰退期会员数) ，其中日取当日，周和月取最后一天的数据 |
| 业务环节 | 用户运营 |

## 指标定位

- 活跃用户数是用户运营 `/report/3` 的一级核心指标，属于用户规模与分层结构维度。
- 所属维度：用户规模与分层结构维度。
- 报告章节：第二章 核心指标总览、第三章 用户规模与分层结构维度深度拆解。
- 指标组：整体用户规模与结构指标。
- 固定拆解链路：`活跃用户数 -> 新消费用户数 -> 新客首单客单价/次月留存率`、`活跃用户数 -> 普通活跃会员数 -> 普通活跃会员消费频次/普通活跃会员客单价`、`活跃用户数 -> vip1活跃会员数 -> vip1活跃会员消费频次/vip1活跃会员客单价`、`活跃用户数 -> vip2活跃会员数 -> vip2活跃会员消费频次/vip2活跃会员客单价`、`活跃用户数 -> vip3活跃会员数 -> vip3活跃会员消费频次/vip3活跃会员客单价`、`活跃用户数 -> 休眠期会员数/流失期用户数/可触达用户数`。

## 下钻子指标

| 层级 | 指标 | code | 所属指标组 |
| :--- | :--- | :--- | :--- |
| 一级子指标 | 新消费用户数 | `firstTranMemberNum` | 新用户表现指标 |
| 二级子指标 | 新客首单客单价 | `firstTranMemberPerCustAmt` | 新用户表现指标 |
| 二级子指标 | 次月留存率 | `nextMonthRetainedRate` | 新用户表现指标 |
| 一级子指标 | 普通活跃会员数 | `regularActiveMemberNum` | 会员分层活跃与价值指标 |
| 二级子指标 | 普通活跃会员消费频次 | `regularActiveMemberTranTimes` | 会员分层活跃与价值指标 |
| 二级子指标 | 普通活跃会员客单价 | `regularActiveMemberPerCustAmt` | 会员分层活跃与价值指标 |
| 一级子指标 | vip1活跃会员数 | `vip1ActiveMemberNum` | 会员分层活跃与价值指标 |
| 二级子指标 | vip1活跃会员消费频次 | `vip1ActiveMemberTranTimes` | 会员分层活跃与价值指标 |
| 二级子指标 | vip1活跃会员客单价 | `vip1ActiveMemberPerCustAmt` | 会员分层活跃与价值指标 |
| 一级子指标 | vip2活跃会员数 | `vip2ActiveMemberNum` | 会员分层活跃与价值指标 |
| 二级子指标 | vip2活跃会员消费频次 | `vip2ActiveMemberTranTimes` | 会员分层活跃与价值指标 |
| 二级子指标 | vip2活跃会员客单价 | `vip2ActiveMemberPerCustAmt` | 会员分层活跃与价值指标 |
| 一级子指标 | vip3活跃会员数 | `vip3ActiveMemberNum` | 会员分层活跃与价值指标 |
| 二级子指标 | vip3活跃会员消费频次 | `vip3ActiveMemberTranTimes` | 会员分层活跃与价值指标 |
| 二级子指标 | vip3活跃会员客单价 | `vip3ActiveMemberPerCustAmt` | 会员分层活跃与价值指标 |
| 一级子指标 | 休眠期会员数 | `dormantMemberNum` | 整体用户规模与结构指标 |
| 一级子指标 | 流失期用户数 | `churnedMemberNum` | 整体用户规模与结构指标 |
| 一级子指标 | 可触达用户数 | `reachMemberNum` | 整体用户规模与结构指标 |

## 边界与禁放规则

- 用户报表不支持品类过滤；不输出品类排名、品类拖累或品类贡献。
- 活跃用户数归入用户规模与分层结构维度，固定放入第二章和第三章，不得放入第四章（会员价值与复购转化）和第五章（用户触达与渠道效率）。
- 休眠期会员数、流失期用户数仅作为活跃用户数的子指标在第三章展示，不得在核心指标总览中展示。
- 该指标下钻链路中数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。
- 区域、趋势证据只能用于解释活跃用户数及其下钻链路，不得扩展为经营总览。
- 任何指标只能放入其对应维度的主章节，禁止跨维度混放。