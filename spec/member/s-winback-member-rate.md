---
id: member-s-winback-member-rate
kind: spec
domain: member
title: 用户挽回率指标详情
tags:
  - report
  - metric
  - user-report
  - winbackMemberRate
  - 用户挽回率
match:
  keywords:
    - 用户挽回率
    - 用户挽回率指标
    - 用户挽回率详情
    - winbackMemberRate
    - 挽回率
    - 会员挽回
---

# 用户挽回率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code winbackMemberRate --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 用户挽回率 |
| 指标英文 code | `winbackMemberRate` |
| 业务定义 | 上月是休眠期然后在本月重新产生了消费的用户数占上月是休眠期的用户数 |
| 统计逻辑 | 上月是休眠期本月重新消费的用户数 / 上月休眠期用户数 |
| 数据来源 | 用户报表 `/report/3`（`qdm-cmr-cli report user`） |

## 指标定位

- 用户挽回率是用户报表 `/report/3` 中休眠期会员数（`dormantMemberNum`）的下游叶子指标。
- 所属维度：用户规模与分层结构。
- 报告章节：第三章 用户规模与分层结构深度拆解。
- 父指标：休眠期会员数（`dormantMemberNum`）。
- 无子指标，为叶子指标。
- **重要**：用户挽回率仅在 CLI 返回有值时展示。当 CLI 返回的指标值为 null 或所有值为 0 时，报告中省略该指标行。

## 下钻子指标

无。用户挽回率为叶子指标，无下钻子指标。

## 边界与禁放规则

- 用户挽回率固定归入"用户规模与分层结构"维度（第三章），禁止放入第四章（用户价值与复购转化）和第五章（用户触达与渠道效率）。
- 不得作为经营分析 `/report/2` 的指标行。
- 用户挽回率不支持下钻品类维度分析（用户报表不支持品类过滤）。
- 用户挽回率仅在 CLI 返回有值时展示。当 CLI 返回值为 null 或全为 0 时，报告中省略该指标行及相关分析段落。
- 区域、趋势证据只能用于解释用户挽回率的表现，不得扩展为用户总览报告。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。