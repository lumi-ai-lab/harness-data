---
id: member-s-regular-active-member-num
kind: template
domain: member
title: 普通活跃会员数分析报告
tags:
  - report
  - template
  - user-report
  - regularActiveMemberNum
  - 普通活跃会员数
match:
  keywords:
    - 普通活跃会员数
    - 普通活跃会员数分析
    - 普通活跃会员数报告模板
---

# 普通活跃会员数分析报告

## 一、报告概述

- **分析指标**：普通活跃会员数（regularActiveMemberNum）
- **分析周期**：<periodValue>
- **分析区域**：<areaName>
- **数据来源**：qdm-cmr-cli report user
- **指标定义**：会员等级为普通会员的活跃会员
- **统计逻辑**：会员等级为普通会员的活跃会员id去重计数
- **上级指标**：活跃用户数（activeMemberNum）

## 二、核心结论

- 当前普通活跃会员数为 **<value><zhCNUnit>**，同比 **<yoyDirection><yoyValue>%**，环比 **<momDirection><momValue>%**。
- 普通活跃会员数占活跃用户数比例为 **<ramRatio>%**，<ratioAssessment>。
- <趋势总结>
- <区域表现总结>

## 三、整体表现

### 3.1 指标概览

| 指标 | 当前值 | 同比 | 环比 | 趋势 |
| :--- | :--- | :--- | :--- | :--- |
| 普通活跃会员数 | <value><zhCNUnit> | <yoyStr> | <momStr> | <trendDirection> |

### 3.2 同比环比分析

- 同比：普通活跃会员数同比 <yoyDirection><yoyValue>%，<yoyAnalysis>。
- 环比：<momAnalysis>。

### 3.3 趋势分析

> 数据来源：`qdm-cmr-cli report user trend --indicator regularActiveMemberNum`

| 日期 | 当期值（万） | 去年同期（万） | 同比方向 |
| :--- | :--- | :--- | :--- |
| <period1> | <current1> | <compare1> | <direction1> |
| ... | ... | ... | ... |

<TrendSummary>

## 四、普通会员消费质量拆解

### 4.1 普通活跃会员消费频次

> 数据来源：`qdm-cmr-cli report user indicators --indicator regularActiveMemberTranTimes --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 普通活跃会员消费频次 | <ramttValue> | <ramttYoyStr> | <ramttMomStr> |

<RamttAnalysis>

### 4.2 普通活跃会员客单价

> 数据来源：`qdm-cmr-cli report user indicators --indicator regularActiveMemberPerCustAmt --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 普通活跃会员客单价 | <rampcaValue> | <rampcaYoyStr> | <rampcaMomStr> |

<RampcaAnalysis>

## 五、区域表现拆解

> 数据来源：`qdm-cmr-cli report user area --indicator regularActiveMemberNum`

### 5.1 区域排名

| 排名 | 区域 | 普通活跃会员数（万） | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | <area1Name> | <area1Current> | <area1MomStr> | <area1YoyStr> |
| 2 | <area2Name> | <area2Current> | <area2MomStr> | <area2YoyStr> |
| 3 | <area3Name> | <area3Current> | <area3MomStr> | <area3YoyStr> |
| 4 | <area4Name> | <area4Current> | <area4MomStr> | <area4YoyStr> |

### 5.2 区域表现分析

- **<area1Name>**：普通活跃会员数最高（<area1Current>万），<area1Performance>。
- **<area2Name>**：<area2Performance>。
- **<area3Name>**：<area3Performance>。
- **<area4Name>**：<area4Performance>。

## 六、核心问题诊断

### 6.1 普通会员规模健康度

- <普通活跃会员数占比是否合理，与VIP会员的比例结构>
- <普通会员数同比下降的可能原因>
- <是否存在普通会员向VIP转化的瓶颈>

### 6.2 普通会员消费质量

- <消费频次是否处于健康水平>
- <客单价与VIP会员的差距分析>

## 七、优化策略

- <策略1：推动普通会员向vip1升级的转化机制>
- <策略2：提升普通会员消费频次的运营活动>
- <策略3：优化普通会员客单价提升策略>
- <策略4：针对普通会员占比偏高区域的重点运营>

## 八、附录

### 8.1 数据取值说明

- **valueUnit**：1=整数，2=百分比/比率，3=小数比率（需乘以100）
- **同比/环比 unit**：1=绝对变化，2=比率变化（需乘以100），3=小数比率变化（百分点）

### 8.2 CLI命令参考

```bash
qdm-cmr-cli indicator detail --code regularActiveMemberNum --full
qdm-cmr-cli report user indicators --indicator regularActiveMemberNum --display-mode yoyMom
qdm-cmr-cli report user trend --indicator regularActiveMemberNum
qdm-cmr-cli report user area --indicator regularActiveMemberNum
```

### 8.3 边界限制

- 用户报表不支持品类过滤。
- 该指标固定归入第三章"用户规模与分层结构维度深度拆解"的会员分层活跃与价值指标组。
- CLI未返回时不等于0，直接省略。