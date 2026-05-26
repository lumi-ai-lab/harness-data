---
id: member-s-regular-active-member-per-cust-amt
kind: template
domain: member
title: 普通活跃会员客单价分析报告
tags:
  - report
  - template
  - user-report
  - regularActiveMemberPerCustAmt
  - 普通活跃会员客单价
match:
  keywords:
    - 普通活跃会员客单价
    - 普通活跃会员客单价分析
    - 普通活跃会员客单价报告模板
---

# 普通活跃会员客单价分析报告

## 一、报告概述

- **分析指标**：普通活跃会员客单价（regularActiveMemberPerCustAmt）
- **分析周期**：<periodValue>
- **分析区域**：<areaName>
- **数据来源**：qdm-cmr-cli report user
- **指标定义**：会员等级为普通会员的活跃会员，他们产生的订单的平均销售额
- **统计逻辑**：普通活跃会员销售额 / 普通活跃会员来客数
- **上级指标**：普通活跃会员数（regularActiveMemberNum）

## 二、核心结论

- 当前普通活跃会员客单价为 **<value>元**，同比 **<yoyDirection><yoyValue>%**，环比 **<momDirection><momValue>%**。
- <客单价评估：与VIP会员客单价对比>
- <区域表现总结>

## 三、整体表现

### 3.1 指标概览

| 指标 | 当前值 | 同比 | 环比 | 趋势 |
| :--- | :--- | :--- | :--- | :--- |
| 普通活跃会员客单价 | <value>元 | <yoyStr> | <momStr> | <trendDirection> |

### 3.2 同比环比分析

- 同比：客单价同比 <yoyDirection><yoyValue>%，<yoyAnalysis>。
- 环比：<momAnalysis>。

### 3.3 趋势分析

> 数据来源：`qdm-cmr-cli report user trend --indicator regularActiveMemberPerCustAmt`

| 日期 | 当期值（元） | 去年同期（元） | 同比方向 |
| :--- | :--- | :--- | :--- |
| <period1> | <current1> | <compare1> | <direction1> |
| ... | ... | ... | ... |

<TrendSummary>

## 四、区域表现拆解

> 数据来源：`qdm-cmr-cli report user area --indicator regularActiveMemberPerCustAmt`

| 排名 | 区域 | 客单价（元） | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | <area1Name> | <area1Current> | <area1MomStr> | <area1YoyStr> |
| 2 | <area2Name> | <area2Current> | <area2MomStr> | <area2YoyStr> |
| 3 | <area3Name> | <area3Current> | <area3MomStr> | <area3YoyStr> |
| 4 | <area4Name> | <area4Current> | <area4MomStr> | <area4YoyStr> |

## 五、核心问题诊断

- <客单价是否偏低，与VIP会员、新客首单客单价的对比>
- <客单价波动的原因分析：促销活动、品类结构变化>
- <区域差异原因>

## 六、优化策略

- <策略1：通过满减、满赠活动提升普通会员客单价>
- <策略2：优化商品推荐，提升连带销售>
- <策略3：针对低客单价区域加强高价值商品推广>

## 七、附录

### 7.1 数据取值说明
- **valueUnit**：1=整数，2=百分比/比率，3=小数比率（需乘以100）
- **同比/环比 unit**：1=绝对变化，2=比率变化（需乘以100），3=小数比率变化（百分点）

### 7.2 CLI命令参考
```bash
qdm-cmr-cli indicator detail --code regularActiveMemberPerCustAmt --full
qdm-cmr-cli report user indicators --indicator regularActiveMemberPerCustAmt --display-mode yoyMom
qdm-cmr-cli report user trend --indicator regularActiveMemberPerCustAmt
qdm-cmr-cli report user area --indicator regularActiveMemberPerCustAmt
```

### 7.3 边界限制
- 用户报表不支持品类过滤。
- 该指标为叶子指标，固定归入第三章"用户规模与分层结构维度深度拆解"的会员分层活跃与价值指标组。
- CLI未返回时不等于0，直接省略。