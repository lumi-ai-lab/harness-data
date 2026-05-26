---
id: member-s-regular-active-member-tran-times
kind: template
domain: member
title: 普通活跃会员消费频次分析报告
tags:
  - report
  - template
  - user-report
  - regularActiveMemberTranTimes
  - 普通活跃会员消费频次
match:
  keywords:
    - 普通活跃会员消费频次
    - 普通活跃会员消费频次分析
    - 普通活跃会员消费频次报告模板
---

# 普通活跃会员消费频次分析报告

## 一、报告概述

- **分析指标**：普通活跃会员消费频次（regularActiveMemberTranTimes）
- **分析周期**：<periodValue>
- **分析区域**：<areaName>
- **数据来源**：qdm-cmr-cli report user
- **指标定义**：会员等级为普通会员的活跃会员，平均每位会员在统计周期内的消费次数
- **统计逻辑**：统计周期内，普通活跃会员来客数 / 普通活跃会员消费人数
- **上级指标**：普通活跃会员数（regularActiveMemberNum）

## 二、核心结论

- 当前普通活跃会员消费频次为 **<value>次**，同比 **<yoyDirection><yoyValue>%**，环比 **<momDirection><momValue>%**。
- <消费频次评估：是否处于健康水平，与VIP会员对比>
- <趋势总结>
- <区域表现总结>

## 三、整体表现

### 3.1 指标概览

| 指标 | 当前值 | 同比 | 环比 | 趋势 |
| :--- | :--- | :--- | :--- | :--- |
| 普通活跃会员消费频次 | <value>次 | <yoyStr> | <momStr> | <trendDirection> |

### 3.2 同比环比分析

- 同比：消费频次同比 <yoyDirection><yoyValue>%，<yoyAnalysis>。
- 环比：<momAnalysis>。

### 3.3 趋势分析

> 数据来源：`qdm-cmr-cli report user trend --indicator regularActiveMemberTranTimes`

| 日期 | 当期值 | 去年同期 | 同比方向 |
| :--- | :--- | :--- | :--- |
| <period1> | <current1> | <compare1> | <direction1> |
| ... | ... | ... | ... |

<TrendSummary>

## 四、区域表现拆解

> 数据来源：`qdm-cmr-cli report user area --indicator regularActiveMemberTranTimes`

| 排名 | 区域 | 消费频次（次） | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | <area1Name> | <area1Current> | <area1MomStr> | <area1YoyStr> |
| 2 | <area2Name> | <area2Current> | <area2MomStr> | <area2YoyStr> |
| 3 | <area3Name> | <area3Current> | <area3MomStr> | <area3YoyStr> |
| 4 | <area4Name> | <area4Current> | <area4MomStr> | <area4YoyStr> |

## 五、核心问题诊断

- <消费频次是否偏低，与VIP会员、复购会员的差距>
- <消费频次下降的可能原因：促销减少、品类吸引力不足>
- <区域差异分析>

## 六、优化策略

- <策略1：通过会员日、积分活动等提升普通会员到店频率>
- <策略2：针对低频会员推送个性化优惠券>
- <策略3：优化品类组合，提升连带购买>

## 七、附录

### 7.1 数据取值说明
- **valueUnit**：1=整数，2=百分比/比率，3=小数比率（需乘以100）
- **同比/环比 unit**：1=绝对变化，2=比率变化（需乘以100），3=小数比率变化（百分点）

### 7.2 CLI命令参考
```bash
qdm-cmr-cli indicator detail --code regularActiveMemberTranTimes --full
qdm-cmr-cli report user indicators --indicator regularActiveMemberTranTimes --display-mode yoyMom
qdm-cmr-cli report user trend --indicator regularActiveMemberTranTimes
qdm-cmr-cli report user area --indicator regularActiveMemberTranTimes
```

### 7.3 边界限制
- 用户报表不支持品类过滤。
- 该指标为叶子指标，固定归入第三章"用户规模与分层结构维度深度拆解"的会员分层活跃与价值指标组。
- CLI未返回时不等于0，直接省略。