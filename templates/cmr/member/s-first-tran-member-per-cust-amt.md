---
id: member-s-first-tran-member-per-cust-amt
kind: template
domain: member
title: 新客首单客单价分析报告
tags:
  - report
  - template
  - user-report
  - firstTranMemberPerCustAmt
  - 新客首单客单价
match:
  keywords:
    - 新客首单客单价
    - 新客首单客单价分析
    - 新客首单客单价报告模板
---

# 新客首单客单价分析报告

## 一、报告概述

- **分析指标**：新客首单客单价（firstTranMemberPerCustAmt）
- **分析周期**：<periodValue>
- **分析区域**：<areaName>
- **数据来源**：qdm-cmr-cli report user
- **指标定义**：统计周期内，首次消费会员的首笔订单的平均消费金额
- **统计逻辑**：新客首次消费销售额 / 新消费会员数
- **上级指标**：新消费用户数（firstTranMemberNum）

## 二、核心结论

- 当前新客首单客单价为 **<value>元**，同比 **<yoyDirection><yoyValue>%**，环比 **<momDirection><momValue>%**。
- <趋势总结：描述客单价变化方向和新客消费质量>
- <区域表现总结：排名最高和最低区域及其客单价水平>

## 三、整体表现

### 3.1 指标概览

| 指标 | 当前值 | 同比 | 环比 | 趋势 |
| :--- | :--- | :--- | :--- | :--- |
| 新客首单客单价 | <value>元 | <yoyStr> | <momStr> | <trendDirection> |

### 3.2 同比环比分析

- 同比：新客首单客单价同比 <yoyDirection><yoyValue>%，<yoyAnalysis>。
- 环比：新客首单客单价环比 <momDirection><momValue>%，<momAnalysis>。

### 3.3 趋势分析

> 数据来源：`qdm-cmr-cli report user trend --indicator firstTranMemberPerCustAmt`

| 日期 | 当期值（元） | 去年同期（元） | 同比方向 |
| :--- | :--- | :--- | :--- |
| <period1> | <current1> | <compare1> | <direction1> |
| <period2> | <current2> | <compare2> | <direction2> |
| ... | ... | ... | ... |

<TrendSummary>

## 四、区域表现拆解

> 数据来源：`qdm-cmr-cli report user area --indicator firstTranMemberPerCustAmt`

### 4.1 区域排名

| 排名 | 区域 | 新客首单客单价（元） | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | <area1Name> | <area1Current> | <area1MomStr> | <area1YoyStr> |
| 2 | <area2Name> | <area2Current> | <area2MomStr> | <area2YoyStr> |
| 3 | <area3Name> | <area3Current> | <area3MomStr> | <area3YoyStr> |
| 4 | <area4Name> | <area4Current> | <area4MomStr> | <area4YoyStr> |

### 4.2 区域表现分析

- **<area1Name>**：新客首单客单价最高（<area1Current>元），<area1Performance>。
- **<area2Name>**：<area2Performance>。
- **<area3Name>**：<area3Performance>。
- **<area4Name>**：<area4Performance>。

## 五、核心问题诊断

### 5.1 新客消费质量

- <新客首单客单价是否处于合理区间>
- <与普通会员客单价、VIP会员客单价对比，是否存在显著差距>
- <客单价下降是否由促销活动、品类结构等因素导致>

### 5.2 区域差异

- <区域间新客首单客单价差异原因分析>
- <高客单价区域和低客单价区域的结构性差异>

## 六、优化策略

- <策略1：优化新客首单商品推荐，提升连带率>
- <策略2：设计新客首单满减/满赠门槛，引导提升客单价>
- <策略3：针对低客单价区域加强高价值商品推广>

## 七、附录

### 7.1 数据取值说明

- **valueUnit**：1=整数，2=百分比/比率，3=小数比率（需乘以100）
- **同比/环比 unit**：1=绝对变化，2=比率变化（需乘以100），3=小数比率变化（百分点）

### 7.2 CLI命令参考

```bash
qdm-cmr-cli indicator detail --code firstTranMemberPerCustAmt --full
qdm-cmr-cli report user indicators --indicator firstTranMemberPerCustAmt --display-mode yoyMom
qdm-cmr-cli report user trend --indicator firstTranMemberPerCustAmt
qdm-cmr-cli report user area --indicator firstTranMemberPerCustAmt
```

### 7.3 边界限制

- 用户报表不支持品类过滤，不输出品类排名、品类拖累或品类贡献。
- 该指标为叶子指标，固定归入第三章"用户规模与分层结构维度深度拆解"的新用户表现指标组。
- 指标配置存在但 CLI 没有返回值，不等于指标值为 0；最终报告应省略无值指标。