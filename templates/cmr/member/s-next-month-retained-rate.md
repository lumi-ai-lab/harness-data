---
id: member-s-next-month-retained-rate
kind: template
domain: member
title: 次月留存率分析报告
tags:
  - report
  - template
  - user-report
  - nextMonthRetainedRate
  - 次月留存率
match:
  keywords:
    - 次月留存率
    - 次月留存率分析
    - 次月留存率报告模板
---

# 次月留存率分析报告

## 一、报告概述

- **分析指标**：次月留存率（nextMonthRetainedRate）
- **分析周期**：<periodValue>
- **分析区域**：<areaName>
- **数据来源**：qdm-cmr-cli report user
- **指标定义**：上个月的新消费会员，在本月继续消费的会员占比
- **统计逻辑**：次月留存会员数 / 上月的新消费会员数
- **上级指标**：新消费用户数（firstTranMemberNum）

> **重要**：该指标仅在 CLI 返回有值时展示。若 CLI 未返回有效值，报告中应省略该指标行，不可填 0。

## 二、核心结论

- 当前次月留存率为 **<value>%**，同比 **<yoyDirection><yoyValue>%**，环比 **<momDirection><momValue>%**。
- <留存率评估：是否达到行业或内部目标水平>
- <趋势总结：留存率变化方向和新客粘性评估>

## 三、整体表现

### 3.1 指标概览

| 指标 | 当前值 | 同比 | 环比 | 趋势 |
| :--- | :--- | :--- | :--- | :--- |
| 次月留存率 | <value>% | <yoyStr> | <momStr> | <trendDirection> |

### 3.2 同比环比分析

- 同比：次月留存率同比 <yoyDirection><yoyValue>%，<yoyAnalysis>。
- 环比：次月留存率环比 <momDirection><momValue>%，<momAnalysis>。

### 3.3 趋势分析

> 数据来源：`qdm-cmr-cli report user trend --indicator nextMonthRetainedRate`

| 日期 | 当期值 | 去年同期 | 同比方向 |
| :--- | :--- | :--- | :--- |
| <period1> | <current1> | <compare1> | <direction1> |
| <period2> | <current2> | <compare2> | <direction2> |
| ... | ... | ... | ... |

<TrendSummary>

## 四、区域表现拆解

> 数据来源：`qdm-cmr-cli report user area --indicator nextMonthRetainedRate`

> **注意**：若区域数据 rows 为空数组，则此处省略区域排名表和分析内容。

### 4.1 区域排名

| 排名 | 区域 | 次月留存率 | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | <area1Name> | <area1Current>% | <area1MomStr> | <area1YoyStr> |

### 4.2 区域表现分析

- **<area1Name>**：<area1Performance>。

## 五、核心问题诊断

### 5.1 新客留存质量

- <次月留存率是否处于健康水平>
- <留存率下降的可能原因：首单体验不佳、商品吸引力不足、缺乏后续触达>
- <与同类企业或同行业留存率对比>

### 5.2 影响因素分析

- <新客首单客单价与留存率的关联分析>
- <不同区域新客留存率差异原因>

## 六、优化策略

- <策略1：优化新客首单体验，提升满意度>
- <策略2：建立新客次月激活机制（优惠券、推送提醒等）>
- <策略3：针对低留存区域加强新客运营和二次触达>

## 七、附录

### 7.1 数据取值说明

- **valueUnit**：1=整数，2=百分比/比率，3=小数比率（需乘以100）
- **同比/环比 unit**：1=绝对变化，2=比率变化（需乘以100），3=小数比率变化（百分点）

### 7.2 CLI命令参考

```bash
qdm-cmr-cli indicator detail --code nextMonthRetainedRate --full
qdm-cmr-cli report user indicators --indicator nextMonthRetainedRate --display-mode yoyMom
qdm-cmr-cli report user trend --indicator nextMonthRetainedRate
qdm-cmr-cli report user area --indicator nextMonthRetainedRate
```

### 7.3 边界限制

- 用户报表不支持品类过滤，不输出品类排名、品类拖累或品类贡献。
- 该指标为叶子指标，固定归入第三章"用户规模与分层结构维度深度拆解"的新用户表现指标组。
- **关键规则**：CLI 未返回有值时报告应省略该指标行，不可填 0。