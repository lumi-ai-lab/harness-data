# 线上消费会员数分析报告

> 报告时间：{{date}} | 区域：{{areaName}} | 报表类型：用户报表（/report/3）
> 指标：线上消费会员数（onlineMemberNum） | 维度：会员价值与复购转化（第四章）

---

## 第一章 报告概述

### 1.1 报告背景

线上消费会员数是指通过线上渠道（及时达、次日达、电商预售、电商接龙、平台接龙、门店接龙等）消费的会员数量，已扣除退货订单。该指标是衡量线上渠道会员活跃度的基础指标，也是评估新零售转型效果的关键标志。

### 1.2 数据范围

- **时间范围**: {{periodType}}: {{periodValue}}
- **区域范围**: {{areaName}}（{{areaId}}），默认全国（不含港澳）
- **数据来源**: 用户报表系统（report/3）
- **统计逻辑**: 通过线上渠道消费的会员id计数去重

### 1.3 核心指标值

| 指标 | 数值 | 环比 | 同比 |
|------|------|------|------|
| 线上消费会员数 | {{value}} | {{mom}} | {{yoy}} |

---

## 第二章 核心结论

<!-- 基于数据总结3-4条核心结论 -->

1. **整体规模**: 全国线上消费会员数为{{value}}人，占消费会员（buyMemberNum，{{buyMemberNumValue}}人）的约{{ratioOfBuy}}%。
2. **趋势方向**: 环比{{momDirection}}{{momValue}}，同比{{yoyDirection}}{{yoyValue}}。
3. **区域差异**: {{bestArea}}区域线上消费会员数最高（{{bestAreaValue}}人），{{worstArea}}区域最低。
4. **线上线下对比**: 线上消费会员数（{{value}}人）远低于线下消费会员数（{{offlineValue}}人），线上渠道渗透率仍有提升空间。

---

## 第三章 整体表现

### 3.1 当前值分析

当前全国线上消费会员数为 **{{value}}人**，线上销售渠道包含及时达、次日达、电商预售、电商接龙、平台接龙、门店接龙等。

### 3.2 同比环比分析

| 对比维度 | 变化率 | 方向 | 解读 |
|----------|--------|------|------|
| 环比（mom） | {{momValue}}% | {{momDirection}} | {{momComment}} |
| 同比（yoy） | {{yoyValue}}% | {{yoyDirection}} | {{yoyComment}} |

> 注: valueUnit=1（整数），mom/yoy unit=2（比率变化）

### 3.3 趋势分析

<!-- 使用 trend 数据描述近30天走势 -->

近30天线上消费会员数呈{{trendPattern}}走势，日均值约{{avgValue}}人。

---

## 第四章 区域表现拆解

<!-- 使用 area 数据描述各管理区域表现 -->

### 4.1 区域排名

| 排名 | 区域 | Code | 线上消费会员数(人) | 环比(%) | 同比(%) |
|------|------|------|-------------------|---------|---------|
| 1 | 粤西 | CN01 | {{cn01Value}} | {{cn01Mom}} | {{cn01Yoy}} |
| 2 | 粤东 | CN18 | {{cn18Value}} | {{cn18Mom}} | {{cn18Yoy}} |
| 3 | 华东 | CN15 | {{cn15Value}} | {{cn15Mom}} | {{cn15Yoy}} |
| 4 | 运营直管 | CN07 | {{cn07Value}} | {{cn07Mom}} | {{cn07Yoy}} |

### 4.2 区域分析要点

- **粤西（CN01）**: 线上会员规模最大，线上化程度领先。
- **粤东（CN18）**: 排名第二，同比增长表现突出。
- **华东（CN15）**: 线上会员规模较小，线上渗透率待提升。
- **运营直管（CN07）**: 规模最小，线上运营能力需加强。

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

1. **数据口径**: 线上消费会员数为整数（valueUnit=1），同比环比为比率变化（unit=2）。已扣除退货订单。
2. **区域范围**: 默认全国（不含港澳），若指定区域则仅呈现该区域数据。
3. **禁止品类**: 用户报表不支持品类维度分析。
4. **叶子指标**: 线上消费会员数为叶子指标，无子指标可下钻。
5. **渠道定义**: 线上渠道包含及时达、次日达、电商预售、电商接龙、平台接龙、门店接龙。

---

## 附录

### 指标信息

| 项目 | 内容 |
|------|------|
| 指标名称 | 线上消费会员数 |
| 英文code | onlineMemberNum |
| 业务定义 | 通过线上渠道消费的会员数量，线上销售渠道包含及时达、次日达、电商预售、电商接龙、平台接龙、门店接龙，退货订单会进行扣减 |
| 统计逻辑 | 通过线上渠道消费的会员id计数去重 |
| 父指标 | 交叉会员数（crossMemberNum） |
| 子指标 | 无（叶子指标） |
| 归属维度 | 会员价值与复购转化（第四章） |

### 数据获取命令

```bash
# 获取指标值和同比环比
qdm-cmr-cli report user indicators --indicator onlineMemberNum --display-mode yoyMom

# 获取趋势数据
qdm-cmr-cli report user trend --indicator onlineMemberNum

# 获取区域排名
qdm-cmr-cli report user area --indicator onlineMemberNum

# 指定区域
qdm-cmr-cli report user indicators --indicator onlineMemberNum --area-type manageAreaId --area CN01 --display-mode yoyMom
```