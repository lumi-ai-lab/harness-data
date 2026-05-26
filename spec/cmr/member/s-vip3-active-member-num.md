---
id: member-s-vip3-active-member-num
kind: spec
domain: member
title: vip3活跃会员数指标详情
tags:
  - report
  - metric
  - user-report
  - vip3ActiveMemberNum
  - vip3活跃会员数
match:
  keywords:
    - vip3活跃会员数
    - vip3活跃会员数指标
    - vip3活跃会员数详情
    - vip3ActiveMemberNum
---

# vip3活跃会员数指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code vip3ActiveMemberNum --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | vip3活跃会员数 |
| 指标英文 code | `vip3ActiveMemberNum` |
| 业务定义 | 会员等级为VIP3的活跃会员 |
| 统计逻辑 | 会员等级为VIP3的活跃会员id去重计数 |
| 业务环节 | 用户规模与分层结构 |

## 指标定位

- vip3活跃会员数是用户报表 `/report/3` 中"用户规模与分层结构"维度的指标。
- 所属维度：用户规模与分层结构。
- 报告章节：第三章 用户规模与分层结构维度深度拆解。
- 所属指标组：会员分层活跃与价值指标。
- 父指标：活跃用户数（`activeMemberNum`）。
- 固定拆解链路：`vip3活跃会员数 -> vip3活跃会员消费频次、vip3活跃会员客单价`。
- 模板结构：非核心指标，8 章模板（有子指标）。

## 下钻子指标

| 层级 | 指标 | code | 所属指标组 |
| :--- | :--- | :--- | :--- |
| 一级子指标 | vip3活跃会员消费频次 | `vip3ActiveMemberTranTimes` | 会员分层活跃与价值指标 |
| 一级子指标 | vip3活跃会员客单价 | `vip3ActiveMemberPerCustAmt` | 会员分层活跃与价值指标 |

## 边界与禁放规则

- vip3活跃会员数及其子指标不得放入第四章（会员价值与复购转化）或第五章（用户触达与渠道效率）。
- 用户报表不支持品类过滤；不输出品类排名、品类拖累或品类贡献。
- 区域支持下钻；未指定区域时固定为全国（不含港澳）。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。
- 指标配置存在但 CLI 没有返回值，不等于指标值为 0；最终报告应省略无值指标。
- 禁止放入会员销售占比、会员复购率等会员价值与复购转化维度指标作为主指标行。