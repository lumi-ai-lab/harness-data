# 交叉会员数分析报告

> 报告时间：{{date}} | 区域：{{areaName}} | 报表类型：用户报表（/report/3）
> 指标：交叉会员数（crossMemberNum） | 维度：会员价值与复购转化（第四章）

---

## 第一章 报告概述

### 1.1 报告背景

交叉会员数是指同时在线上和线下都有过至少一次消费的会员数量，是衡量会员线上线下融合消费行为的关键指标。交叉会员规模越大，说明会员的多渠道消费习惯越成熟，对整体销售的稳定性和增长潜力贡献越大。

### 1.2 数据范围

- **时间范围**: {{periodType}}: {{periodValue}}
- **区域范围**: {{areaName}}（{{areaId}}），默认全国（不含港澳）
- **数据来源**: 用户报表系统（report/3）
- **统计逻辑**: 同时在线上和线下都有过至少一次消费的会员id去重计数

### 1.3 核心指标值

| 指标 | 数值 | 环比 | 同比 |
|------|------|------|------|
| 交叉会员数 | {{value}} | {{mom}} | {{yoy}} |

---

## 第二章 核心结论

<!-- 基于数据总结3-5条核心结论 -->

1. **整体规模**: 全国交叉会员数为{{value}}人，在消费会员（buyMemberNum）中的占比约{{crossRatio}}%。
2. **趋势方向**: 环比{{momDirection}}{{momValue}}，同比{{yoyDirection}}{{yoyValue}}。
3. **区域差异**: {{bestArea}}区域交叉会员数最高（{{bestAreaValue}}人），{{worstArea}}区域最低。
4. **线上线下结构**: 线下消费会员数{{offlineValue}}人，线上消费会员数{{onlineValue}}人，交叉会员仅占线下消费会员的{{crossOfflineRatio}}%。

---

## 第三章 整体表现

### 3.1 当前值分析

当前全国交叉会员数为 **{{value}}人**，无阈值要求。

### 3.2 同比环比分析

| 对比维度 | 变化率 | 方向 | 解读 |
|----------|--------|------|------|
| 环比（mom） | {{momValue}}% | {{momDirection}} | {{momComment}} |
| 同比（yoy） | {{yoyValue}}% | {{yoyDirection}} | {{yoyComment}} |

> 注: valueUnit=1（整数），mom/yoy unit=2（比率变化）

### 3.3 趋势分析

<!-- 使用 trend 数据描述近30天走势 -->

近30天交叉会员数呈{{trendPattern}}走势，日均值约{{avgValue}}人，波动区间在{{minValue}} ~ {{maxValue}}之间。

---

## 第四章 区域表现拆解

<!-- 使用 area 数据描述各管理区域表现 -->

### 4.1 区域排名

| 排名 | 区域 | Code | 交叉会员数(人) | 环比(%) | 同比(%) |
|------|------|------|---------------|---------|---------|
| 1 | 粤西 | CN01 | {{cn01Value}} | {{cn01Mom}} | {{cn01Yoy}} |
| 2 | 粤东 | CN18 | {{cn18Value}} | {{cn18Mom}} | {{cn18Yoy}} |
| 3 | 华东 | CN15 | {{cn15Value}} | {{cn15Mom}} | {{cn15Yoy}} |
| 4 | 运营直管 | CN07 | {{cn07Value}} | {{cn07Mom}} | {{cn07Yoy}} |

### 4.2 区域分析要点

- **粤西（CN01）**: 交叉会员数遥遥领先，线上线下融合消费基础最好。
- **粤东（CN18）**: 排名第二，与粤西有一定差距。
- **华东（CN15）**: 规模较小，需加强线上线下联动。
- **运营直管（CN07）**: 规模最小，需关注渠道覆盖。

---

## 第五章 父子链路分析

### 5.1 拆解链路

```
门店会员销售占比 (memberSaleAmtRate)
  └── 交叉会员数 (crossMemberNum)  ← 当前指标
        ├── 线下消费会员数 (offlineMemberNum)
        └── 线上消费会员数 (onlineMemberNum)
```

### 5.2 子指标概况

| 子指标 | 当前值 | 环比 | 同比 |
|--------|--------|------|------|
| 线下消费会员数 | {{offlineValue}} | {{offlineMom}} | {{offlineYoy}} |
| 线上消费会员数 | {{onlineValue}} | {{onlineMom}} | {{onlineYoy}} |

### 5.3 链路分析

<!-- 分析父子指标的联动关系 -->

交叉会员数是线下消费会员和线上消费会员的交集。交叉会员数 / 消费会员数的比率反映了会员多渠道消费的渗透率。

---

## 第六章 核心问题诊断

<!-- 基于数据诊断核心问题 -->

1. **{{problem1Title}}**: {{problem1Desc}}
2. **{{problem2Title}}**: {{problem2Desc}}
3. **{{problem3Title}}**: {{problem3Desc}}

---

## 第七章 优化策略

<!-- 提出针对性优化策略 -->

### 7.1 {{strategy1Title}}

{{strategy1Desc}}

### 7.2 {{strategy2Title}}

{{strategy2Desc}}

---

## 第八章 风险提示

1. **数据口径**: 交叉会员数为整数（valueUnit=1），同比环比为比率变化（unit=2）。
2. **区域范围**: 默认全国（不含港澳），若指定区域则仅呈现该区域数据。
3. **禁止品类**: 用户报表不支持品类维度分析。
4. **交叉定义**: 仅统计同时在线上和线下都有过消费的会员，单一渠道消费者不计入。

---

## 附录

### 指标信息

| 项目 | 内容 |
|------|------|
| 指标名称 | 交叉会员数 |
| 英文code | crossMemberNum |
| 业务定义 | 同时在线上和线下都有过至少一次消费的会员数量 |
| 统计逻辑 | 同时在线上和线下都有过至少一次消费的会员id去重计数 |
| 父指标 | 门店会员销售占比（memberSaleAmtRate） |
| 子指标 | 线下消费会员数、线上消费会员数 |
| 归属维度 | 会员价值与复购转化（第四章） |

### 数据获取命令

```bash
# 获取指标值和同比环比
qdm-cmr-cli report user indicators --indicator crossMemberNum --display-mode yoyMom

# 获取趋势数据
qdm-cmr-cli report user trend --indicator crossMemberNum

# 获取区域排名
qdm-cmr-cli report user area --indicator crossMemberNum

# 指定区域
qdm-cmr-cli report user indicators --indicator crossMemberNum --area-type manageAreaId --area CN18 --display-mode yoyMom
```