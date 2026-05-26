---
id: member-s-first-tran-member-num
kind: template
domain: member
title: 新消费用户数分析报告
tags:
  - report
  - template
  - user-report
  - firstTranMemberNum
  - 新消费用户数
match:
  keywords:
    - 新消费用户数
    - 新消费用户数分析
    - 新消费用户数报告模板
---

# 新消费用户数分析报告

## 一、报告概述

- **分析指标**：新消费用户数（firstTranMemberNum）
- **分析周期**：<periodValue>
- **分析区域**：<areaName>
- **数据来源**：qdm-cmr-cli report user
- **指标定义**：用户的历史首次消费时间处于统计周期内的用户数
- **统计逻辑**：统计周期内，产生了首次消费的会员id计数
- **上级指标**：活跃用户数（activeMemberNum）

## 二、核心结论

- 当前新消费用户数为 **<value>**，同比 **<yoyDirection><yoyValue>%**，环比 **<momDirection><momValue>%**。
- 新消费用户数占活跃用户数比例为 **<ftRatio>%**，<ratioAssessment>。
- <趋势总结：描述30天趋势走向和新消费用户波动特征>
- <区域表现总结：排名最高和最低区域及其同比环比表现>

## 三、整体表现

### 3.1 指标概览

| 指标 | 当前值 | 同比 | 环比 | 趋势 |
| :--- | :--- | :--- | :--- | :--- |
| 新消费用户数 | <value> | <yoyStr> | <momStr> | <trendDirection> |

### 3.2 同比环比分析

- 同比：新消费用户数同比 <yoyDirection><yoyValue>%，<yoyAnalysis>。
- 环比：新消费用户数环比 <momDirection><momValue>%，<momAnalysis>。

### 3.3 趋势分析

> 数据来源：`qdm-cmr-cli report user trend --indicator firstTranMemberNum`

| 日期 | 当期值 | 去年同期 | 同比方向 |
| :--- | :--- | :--- | :--- |
| <period1> | <current1> | <compare1> | <direction1> |
| <period2> | <current2> | <compare2> | <direction2> |
| <period3> | <current3> | <compare3> | <direction3> |
| ... | ... | ... | ... |

<TrendSummary>

## 四、新客消费质量拆解

### 4.1 新客首单客单价

> 数据来源：`qdm-cmr-cli report user indicators --indicator firstTranMemberPerCustAmt --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 新客首单客单价 | <ftpcaValue> | <ftpcaYoyStr> | <ftpcaMomStr> |

<FtpcaAnalysis>

### 4.2 次月留存率

> 数据来源：`qdm-cmr-cli report user indicators --indicator nextMonthRetainedRate --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 次月留存率 | <nmrrValue> | <nmrrYoyStr> | <nmrrMomStr> |

<NmrrAnalysis>

## 五、区域表现拆解

> 数据来源：`qdm-cmr-cli report user area --indicator firstTranMemberNum`

### 5.1 区域排名

| 排名 | 区域 | 新消费用户数 | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | <area1Name> | <area1Current> | <area1MomStr> | <area1YoyStr> |
| 2 | <area2Name> | <area2Current> | <area2MomStr> | <area2YoyStr> |
| 3 | <area3Name> | <area3Current> | <area3MomStr> | <area3YoyStr> |
| 4 | <area4Name> | <area4Current> | <area4MomStr> | <area4YoyStr> |

### 5.2 区域表现分析

- **<area1Name>**：新消费用户数最高（<area1Current>），占比 <area1Share>%，<area1Performance>。
- **<area2Name>**：新消费用户数第二（<area2Current>），<area2Performance>。
- **<area3Name>**：<area3Performance>。
- **<area4Name>**：<area4Performance>。

## 六、核心问题诊断

### 6.1 拉新效率

- <新消费用户数是否满足增长预期>
- <新消费用户数占活跃用户数比例是否健康>
- <是否存在拉新瓶颈（渠道、营销活动、季节性因素）>

### 6.2 新客质量

- <新客首单客单价是否达到预期水平>
- <次月留存率是否达标，反映新客粘性>

## 七、优化策略

### 7.1 拉新策略

- <策略1：拓展拉新渠道，加大推广力度>
- <策略2：优化新客权益设计，降低首单门槛>
- <策略3：针对不同区域制定差异化拉新方案>

### 7.2 新客转化策略

- <策略1：提升新客首单体验，提高客单价>
- <策略2：建立新客次月激活机制，提升留存率>

## 八、附录

### 8.1 数据取值说明

- **valueUnit**：1=整数，2=百分比/比率，3=小数比率（需乘以100）
- **同比/环比 unit**：1=绝对变化，2=比率变化（需乘以100），3=小数比率变化（百分点）

### 8.2 CLI命令参考

```bash
# 获取指标详情
qdm-cmr-cli indicator detail --code firstTranMemberNum --full

# 获取指标值（含同比环比）
qdm-cmr-cli report user indicators --indicator firstTranMemberNum --display-mode yoyMom

# 获取趋势数据
qdm-cmr-cli report user trend --indicator firstTranMemberNum

# 获取区域数据
qdm-cmr-cli report user area --indicator firstTranMemberNum

# 区域下钻示例
qdm-cmr-cli report user indicators --indicator firstTranMemberNum --area-type manageAreaId --area CN01 --display-mode yoyMom
```

### 8.3 边界限制

- 用户报表不支持品类过滤，不输出品类排名、品类拖累或品类贡献。
- 该指标固定归入第三章"用户规模与分层结构维度深度拆解"的新用户表现指标组，不得放入第四章或第五章。
- 指标配置存在但 CLI 没有返回值，不等于指标值为 0；最终报告应省略无值指标。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。