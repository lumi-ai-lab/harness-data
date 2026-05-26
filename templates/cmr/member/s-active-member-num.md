---
id: member-s-active-member-num
kind: template
domain: member
title: 活跃用户数分析报告
tags:
  - report
  - template
  - user-report
  - activeMemberNum
  - 活跃用户数
match:
  keywords:
    - 活跃用户数
    - 活跃用户数分析
    - 活跃用户数报告模板
---

# 活跃用户数分析报告

## 一、报告概述

- **分析指标**：活跃用户数（activeMemberNum）
- **分析周期**：<periodValue>
- **分析区域**：<areaName>
- **数据来源**：qdm-cmr-cli report user
- **指标定义**：统计时间内，会员生命周期属于成长期+成熟期+衰退期的会员数
- **统计逻辑**：sum(成长期会员数 + 成熟期会员数 + 衰退期会员数)，其中日取当日，周和月取最后一天的数据

## 二、核心结论

- 当前活跃用户数为 **<value><zhCNUnit>**，同比 **<yoyDirection><yoyValue>%**，环比 **<momDirection><momValue>%**。
- <趋势总结：描述30天趋势走向，是否持续增长或波动>
- <区域表现总结：排名最高和最低区域及其同比环比表现>

## 三、整体表现

### 3.1 指标概览

| 指标 | 当前值 | 同比 | 环比 | 趋势 |
| :--- | :--- | :--- | :--- | :--- |
| 活跃用户数 | <value><zhCNUnit> | <yoyStr> | <momStr> | <trendDirection> |

### 3.2 同比环比分析

- 同比：活跃用户数同比 <yoyDirection><yoyValue>%，<yoyAnalysis>。
- 环比：活跃用户数环比 <momDirection><momValue>%，<momAnalysis>。

### 3.3 趋势分析

> 数据来源：`qdm-cmr-cli report user trend --indicator activeMemberNum`

| 日期 | 当期值（万） | 去年同期（万） | 同比方向 |
| :--- | :--- | :--- | :--- |
| <period1> | <current1> | <compare1> | <direction1> |
| <period2> | <current2> | <compare2> | <direction2> |
| <period3> | <current3> | <compare3> | <direction3> |
| ... | ... | ... | ... |

<TrendSummary>

## 四、用户分层结构拆解

### 4.1 新消费用户数

> 数据来源：`qdm-cmr-cli report user indicators --indicator firstTranMemberNum --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 新消费用户数 | <ftValue> | <ftYoyStr> | <ftMomStr> |

<FirstTranAnalysis>

### 4.2 新客首单客单价

> 数据来源：`qdm-cmr-cli report user indicators --indicator firstTranMemberPerCustAmt --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 新客首单客单价 | <ftpcaValue> | <ftpcaYoyStr> | <ftpcaMomStr> |

<FtpcaAnalysis>

### 4.3 次月留存率

> 数据来源：`qdm-cmr-cli report user indicators --indicator nextMonthRetainedRate --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 次月留存率 | <nmrrValue> | <nmrrYoyStr> | <nmrrMomStr> |

<NmrrAnalysis>

### 4.4 普通活跃会员数

> 数据来源：`qdm-cmr-cli report user indicators --indicator regularActiveMemberNum --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 普通活跃会员数 | <ramValue> | <ramYoyStr> | <ramMomStr> |

<RamAnalysis>

### 4.5 普通活跃会员消费频次

> 数据来源：`qdm-cmr-cli report user indicators --indicator regularActiveMemberTranTimes --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 普通活跃会员消费频次 | <ramttValue> | <ramttYoyStr> | <ramttMomStr> |

<RamttAnalysis>

### 4.6 普通活跃会员客单价

> 数据来源：`qdm-cmr-cli report user indicators --indicator regularActiveMemberPerCustAmt --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 普通活跃会员客单价 | <rampcaValue> | <rampcaYoyStr> | <rampcaMomStr> |

<RampcaAnalysis>

### 4.7 VIP分层会员规模

> 数据来源：`qdm-cmr-cli report user indicators --indicator <vipIndicatorCode> --display-mode yoyMom`

| VIP等级 | 会员数 | 同比 | 环比 | 消费频次 | 同比 | 客单价 | 同比 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| vip1 | <vip1Num> | <vip1NumYoy> | <vip1NumMom> | <vip1TT> | <vip1TTYoy> | <vip1PCA> | <vip1PCAYoy> |
| vip2 | <vip2Num> | <vip2NumYoy> | <vip2NumMom> | <vip2TT> | <vip2TTYoy> | <vip2PCA> | <vip2PCAYoy> |
| vip3 | <vip3Num> | <vip3NumYoy> | <vip3NumMom> | <vip3TT> | <vip3TTYoy> | <vip3PCA> | <vip3PCAYoy> |

<VipAnalysis>

### 4.8 休眠与流失用户规模

> 数据来源：`qdm-cmr-cli report user indicators --indicator dormantMemberNum --display-mode yoyMom`

| 指标 | 当前值 | 同比 | 环比 |
| :--- | :--- | :--- | :--- |
| 休眠期会员数 | <dormantValue> | <dormantYoyStr> | <dormantMomStr> |
| 流失期用户数 | <churnedValue> | <churnedYoyStr> | <churnedMomStr> |

<DormantChurnedAnalysis>

## 五、区域表现拆解

> 数据来源：`qdm-cmr-cli report user area --indicator activeMemberNum`

### 5.1 区域排名

| 排名 | 区域 | 活跃用户数（万） | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | <area1Name> | <area1Current> | <area1MomStr> | <area1YoyStr> |
| 2 | <area2Name> | <area2Current> | <area2MomStr> | <area2YoyStr> |
| 3 | <area3Name> | <area3Current> | <area3MomStr> | <area3YoyStr> |
| 4 | <area4Name> | <area4Current> | <area4MomStr> | <area4YoyStr> |

### 5.2 区域表现分析

- **<area1Name>**：活跃用户数最高（<area1Current>万），占比 <area1Share>%，<area1Performance>。
- **<area2Name>**：活跃用户数第二（<area2Current>万），<area2Performance>。
- **<area3Name>**：<area3Performance>。
- **<area4Name>**：<area4Performance>。

## 六、核心问题诊断

### 6.1 用户规模健康度

- <问题1：如果活跃用户数同比下降，是否存在用户流失加剧>
- <问题2：如果新消费用户数不足，是否存在获客困难>
- <问题3：休眠期/流失期用户占比是否过高>

### 6.2 VIP结构合理性

- <VIP各层级会员数量分布是否合理，是否存在断层>
- <各VIP层级消费频次和客单价对比分析>
- <VIP升级转化是否存在瓶颈>

### 6.3 区域差异分析

- <区域间活跃用户数差异原因分析>
- <同比增长领先/落后区域的归因>

## 七、优化策略

### 7.1 用户规模提升策略

- <策略1：针对新消费用户数不足，如何提升拉新效率>
- <策略2：针对次月留存率偏低，如何提升新客留存>
- <策略3：针对休眠/流失用户，如何实施激活与召回>

### 7.2 VIP分层运营策略

- <策略1：普通活跃会员向vip1升级的转化策略>
- <策略2：各VIP等级权益差异化运营>
- <策略3：高价值vip3会员的维护与防流失>

### 7.3 区域差异化策略

- <策略1：高活跃区域的成功经验复制>
- <策略2：低活跃区域的针对性提升方案>

## 八、风险提示

- <风险1：如果活跃用户数持续下降，可能影响整体销售大盘>
- <风险2：如果新消费用户数增速低于流失用户数增速，用户池将收缩>
- <风险3：VIP分层结构如果偏重于低等级，需关注用户价值升级动力>

## 九、附录

### 9.1 数据取值说明

- **valueUnit**：1=整数，2=百分比/比率，3=小数比率（需乘以100）
- **同比/环比 unit**：1=绝对变化，2=比率变化（需乘以100），3=小数比率变化（百分点）
- **zhCNUnit**：中文单位，如"万"
- **threshold.compareSymbol**：GE（大于等于）、LE（小于等于）、GT（大于）、LT（小于）
- **threshold.compareValueType**：1=绝对值，2=百分比

### 9.2 CLI命令参考

```bash
# 获取指标详情
qdm-cmr-cli indicator detail --code activeMemberNum --full

# 获取指标值（含同比环比）
qdm-cmr-cli report user indicators --indicator activeMemberNum --display-mode yoyMom

# 获取趋势数据
qdm-cmr-cli report user trend --indicator activeMemberNum

# 获取区域数据
qdm-cmr-cli report user area --indicator activeMemberNum

# 区域下钻示例
qdm-cmr-cli report user indicators --indicator activeMemberNum --area-type manageAreaId --area CN01 --display-mode yoyMom
```

### 9.3 边界限制

- 用户报表不支持品类过滤，不输出品类排名、品类拖累或品类贡献。
- 该指标及其所有子指标固定归入第三章"用户规模与分层结构维度深度拆解"，不得放入第四章或第五章。
- 指标配置存在但 CLI 没有返回值，不等于指标值为 0；最终报告应省略无值指标。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。