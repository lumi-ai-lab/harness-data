# 线下消费会员数分析报告

> 报告时间：{{date}} | 区域：{{areaName}} | 报表类型：用户报表（/report/3）
> 指标：线下消费会员数（offlineMemberNum） | 维度：会员价值与复购转化（第四章）

---

## 第一章 报告概述

### 1.1 报告背景

线下消费会员数是指通过线下渠道（门店POS等）消费的会员数量，已扣除退货订单。该指标是衡量线下渠道会员活跃度的基础指标，也是交叉会员数的重要组成部分。

### 1.2 数据范围

- **时间范围**: {{periodType}}: {{periodValue}}
- **区域范围**: {{areaName}}（{{areaId}}），默认全国（不含港澳）
- **数据来源**: 用户报表系统（report/3）
- **统计逻辑**: 按销售小票ID统计的有会员ID标识的线下会员id去重

### 1.3 核心指标值

| 指标 | 数值 | 环比 | 同比 |
|------|------|------|------|
| 线下消费会员数 | {{value}} | {{mom}} | {{yoy}} |

---

## 第二章 核心结论

<!-- 基于数据总结3-4条核心结论 -->

1. **整体规模**: 全国线下消费会员数为{{value}}人，占消费会员（buyMemberNum，{{buyMemberNumValue}}人）的约{{ratioOfBuy}}%。
2. **趋势方向**: 环比{{momDirection}}{{momValue}}，同比{{yoyDirection}}{{yoyValue}}。
3. **区域差异**: {{bestArea}}区域线下消费会员数最高（{{bestAreaValue}}人），{{worstArea}}区域最低。
4. **渠道占比**: 线下消费会员数远超线上（线上{{onlineValue}}人），线下仍是会员消费主渠道。

---

## 第三章 整体表现

### 3.1 当前值分析

当前全国线下消费会员数为 **{{value}}人**，占消费会员总数的绝大多数，体现线下渠道在会员消费中的主导地位。

### 3.2 同比环比分析

| 对比维度 | 变化率 | 方向 | 解读 |
|----------|--------|------|------|
| 环比（mom） | {{momValue}}% | {{momDirection}} | {{momComment}} |
| 同比（yoy） | {{yoyValue}}% | {{yoyDirection}} | {{yoyComment}} |

> 注: valueUnit=1（整数），mom/yoy unit=2（比率变化）

### 3.3 趋势分析

<!-- 使用 trend 数据描述近30天走势 -->

近30天线下消费会员数呈{{trendPattern}}走势，日均值约{{avgValue}}人。

---

## 第四章 区域表现拆解

<!-- 使用 area 数据描述各管理区域表现 -->

### 4.1 区域排名

| 排名 | 区域 | Code | 线下消费会员数(人) | 环比(%) | 同比(%) |
|------|------|------|-------------------|---------|---------|
| 1 | 粤西 | CN01 | {{cn01Value}} | {{cn01Mom}} | {{cn01Yoy}} |
| 2 | 粤东 | CN18 | {{cn18Value}} | {{cn18Mom}} | {{cn18Yoy}} |
| 3 | 华东 | CN15 | {{cn15Value}} | {{cn15Mom}} | {{cn15Yoy}} |
| 4 | 运营直管 | CN07 | {{cn07Value}} | {{cn07Mom}} | {{cn07Yoy}} |

### 4.2 区域分析要点

- **粤西（CN01）**: 线下会员规模最大，基础扎实。
- **粤东（CN18）**: 排名第二，与粤西同为线下消费主力区域。
- **华东（CN15）**: 规模适中。
- **运营直管（CN07）**: 规模最小，但同比增长率突出。

---

## 第五章 核心问题诊断

<!-- 基于数据诊断核心问题 -->

1. **{{problem1Title}}**: {{problem1Desc}}
2. **{{problem2Title}}**: {{problem2Desc}}
3. **{{problem3Title}}**: {{problem3Desc}}

---

## 第六章 优化策略

<!-- 提出针对性优化策略 -->

### 6.1 {{strategy1Title}}

{{strategy1Desc}}

### 6.2 {{strategy2Title}}

{{strategy2Desc}}

---

## 第七章 风险提示

1. **数据口径**: 线下消费会员数为整数（valueUnit=1），同比环比为比率变化（unit=2）。已扣除退货订单。
2. **区域范围**: 默认全国（不含港澳），若指定区域则仅呈现该区域数据。
3. **禁止品类**: 用户报表不支持品类维度分析。
4. **叶子指标**: 线下消费会员数为叶子指标，无子指标可下钻。

---

## 附录

### 指标信息

| 项目 | 内容 |
|------|------|
| 指标名称 | 线下消费会员数 |
| 英文code | offlineMemberNum |
| 业务定义 | 通过线下渠道消费的会员数量，退货订单会进行扣减 |
| 统计逻辑 | 按销售小票ID统计的有会员ID标识的线下会员id去重 |
| 父指标 | 交叉会员数（crossMemberNum） |
| 子指标 | 无（叶子指标） |
| 归属维度 | 会员价值与复购转化（第四章） |

### 数据获取命令

```bash
# 获取指标值和同比环比
qdm-cmr-cli report user indicators --indicator offlineMemberNum --display-mode yoyMom

# 获取趋势数据
qdm-cmr-cli report user trend --indicator offlineMemberNum

# 获取区域排名
qdm-cmr-cli report user area --indicator offlineMemberNum

# 指定区域
qdm-cmr-cli report user indicators --indicator offlineMemberNum --area-type manageAreaId --area CN01 --display-mode yoyMom
```