# 门店会员销售占比分析报告

> 报告时间：{{date}} | 区域：{{areaName}} | 报表类型：用户报表（/report/3）
> 指标：门店会员销售占比（memberSaleAmtRate） | 维度：会员价值与复购转化（第四章）

---

## 第一章 报告概述

### 1.1 报告背景

门店会员销售占比是衡量会员消费对整体销售额贡献度的核心指标。该指标通过计算会员销售额占总门店销售额的比重，反映会员体系的商业价值与销售转化效率。

### 1.2 数据范围

- **时间范围**: {{periodType}}: {{periodValue}}
- **区域范围**: {{areaName}}（{{areaId}}），默认全国（不含港澳）
- **数据来源**: 用户报表系统（report/3）
- **统计逻辑**: 会员销售额 / 销售额

### 1.3 核心指标值

| 指标 | 数值 | 环比 | 同比 | 阈值 |
|------|------|------|------|------|
| 门店会员销售占比 | {{value}}% | {{mom}} | {{yoy}} | >=60% |

---

## 第二章 核心结论

<!-- 基于数据总结3-5条核心结论 -->

1. **整体表现**: 全国门店会员销售占比为{{value}}%，{{thresholdStatus}}60%的阈值线。
2. **趋势方向**: 环比{{momDirection}}{{momValue}}个百分点，同比{{yoyDirection}}{{yoyValue}}个百分点。
3. **区域差异**: {{bestArea}}区域表现最优（{{bestAreaValue}}%），{{worstArea}}区域表现最弱（{{worstAreaValue}}%）。
4. **交叉会员贡献**: 交叉会员是线上线下融合消费的核心群体，其规模和活跃度直接影响会员销售占比。

---

## 第三章 整体表现

### 3.1 当前值分析

当前门店会员销售占比为 **{{value}}%**，{{thresholdComment}}。

- 阈值要求: >= 60%
- 达标状态: {{thresholdStatus}}

### 3.2 同比环比分析

| 对比维度 | 变化值 | 方向 | 解读 |
|----------|--------|------|------|
| 环比（mom） | {{momValue}}个百分点 | {{momDirection}} | {{momComment}} |
| 同比（yoy） | {{yoyValue}}个百分点 | {{yoyDirection}} | {{yoyComment}} |

> 注: valueUnit=3（小数比率），mom/yoy unit=3（百分点变化）

### 3.3 趋势分析

<!-- 使用 trend 数据描述近30天走势 -->

近30天门店会员销售占比呈{{trendPattern}}走势，波动区间在{{minValue}}% ~ {{maxValue}}%之间。

---

## 第四章 区域表现拆解

<!-- 使用 area 数据描述各管理区域表现 -->

### 4.1 区域排名

| 排名 | 区域 | Code | 当前值(%) | 环比(百分点) | 同比(百分点) |
|------|------|------|-----------|-------------|-------------|
| 1 | 粤西 | CN01 | {{cn01Value}} | {{cn01Mom}} | {{cn01Yoy}} |
| 2 | 运营直管 | CN07 | {{cn07Value}} | {{cn07Mom}} | {{cn07Yoy}} |
| 3 | 粤东 | CN18 | {{cn18Value}} | {{cn18Mom}} | {{cn18Yoy}} |
| 4 | 华东 | CN15 | {{cn15Value}} | {{cn15Mom}} | {{cn15Yoy}} |

### 4.2 区域分析要点

- **粤西（CN01）**: 会员销售占比排名第一，表现稳定。
- **运营直管（CN07）**: 表现靠前，同比提升明显。
- **粤东（CN18）**: 处于中游，与粤西存在一定差距。
- **华东（CN15）**: 排名靠后，未达到60%阈值线，需重点关注。

---

## 第五章 父子链路分析

### 5.1 拆解链路

```
门店会员销售占比 (memberSaleAmtRate)
  └── 交叉会员数 (crossMemberNum)
        ├── 线下消费会员数 (offlineMemberNum)
        └── 线上消费会员数 (onlineMemberNum)
```

### 5.2 子指标概况

| 子指标 | 当前值 | 环比 | 同比 |
|--------|--------|------|------|
| 交叉会员数 | {{crossMemberNumValue}} | {{crossMom}} | {{crossYoy}} |
| 线下消费会员数 | {{offlineValue}} | {{offlineMom}} | {{offlineYoy}} |
| 线上消费会员数 | {{onlineValue}} | {{onlineMom}} | {{onlineYoy}} |

### 5.3 链路分析

<!-- 分析父子指标的联动关系 -->

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

### 7.3 {{strategy3Title}}

{{strategy3Desc}}

---

## 第八章 风险提示

1. **数据口径**: 会员销售占比为小数比率（valueUnit=3），展示时已转换为百分比。同比环比为百分点变化（unit=3）。
2. **区域范围**: 默认全国（不含港澳），若指定区域则仅呈现该区域数据。
3. **禁止品类**: 用户报表不支持品类维度分析。
4. **阈值风险**: 若会员销售占比持续低于60%阈值，需及时排查原因。

---

## 第九章 附录

### 9.1 指标信息

| 项目 | 内容 |
|------|------|
| 指标名称 | 门店会员销售占比 |
| 英文code | memberSaleAmtRate |
| 业务定义 | 会员销售额占总门店销售额比重 |
| 统计逻辑 | 会员销售额 / 销售额 |
| 业务环节 | 销售经营 |
| 归属维度 | 会员价值与复购转化（第四章） |

### 9.2 数据获取命令

```bash
# 获取指标值和同比环比
qdm-cmr-cli report user indicators --indicator memberSaleAmtRate --display-mode yoyMom

# 获取趋势数据
qdm-cmr-cli report user trend --indicator memberSaleAmtRate

# 获取区域排名
qdm-cmr-cli report user area --indicator memberSaleAmtRate

# 指定区域
qdm-cmr-cli report user indicators --indicator memberSaleAmtRate --area-type manageAreaId --area CN01 --display-mode yoyMom
```

### 9.3 子指标查询

```bash
# 交叉会员数
qdm-cmr-cli report user indicators --indicator crossMemberNum --display-mode yoyMom

# 线下消费会员数
qdm-cmr-cli report user indicators --indicator offlineMemberNum --display-mode yoyMom

# 线上消费会员数
qdm-cmr-cli report user indicators --indicator onlineMemberNum --display-mode yoyMom
```