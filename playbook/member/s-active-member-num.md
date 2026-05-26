---
id: member-s-active-member-num
kind: playbook
domain: member
title: 活跃用户数报告生成指引
tags:
  - report
  - playbook
  - user-report
  - activeMemberNum
  - 活跃用户数
match:
  keywords:
    - 活跃用户数
    - 活跃用户数报告
    - 活跃用户数玩法
    - activeMemberNum报告
---

# 活跃用户数报告生成指引

> 命令使用 `qdm-cmr-cli report user`，获取用户报表 `/report/3` 的活跃用户数指标分析。

## 1. 获取指标详情

```bash
qdm-cmr-cli indicator detail --code activeMemberNum --full
```

输出示例：
```json
{
  "indicatorsName": "活跃用户数",
  "indicatorsCodeEn": "activeMemberNum",
  "businessDefinition": "统计时间内，会员生命周期属于成长期+成熟期+衰退期的会员数",
  "statisticalLogic": "sum(成长期会员数 + 成熟期会员数 + 衰退期会员数) ，其中日取当日，周和月取最后一天的数据"
}
```

## 2. 获取指标值（含同比环比）

```bash
qdm-cmr-cli report user indicators --indicator activeMemberNum --display-mode yoyMom
```

输出示例（活跃用户数核心值）：
```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeId": "manageAreaId",
    "storeTypeName": "管理区域",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "activeMemberNum",
    "indicatorName": "活跃用户数",
    "displayMode": "yoyMom"
  },
  "items": [
    {
      "indicatorCode": "activeMemberNum",
      "indicatorName": "活跃用户数",
      "value": 624.33,
      "valueUnit": 1,
      "zhCNUnit": "万",
      "yoy": {
        "arrowStatus": "up",
        "status": "up",
        "unit": 2,
        "value": 0.0053
      },
      "mom": {
        "arrowStatus": "up",
        "status": "up",
        "unit": 2,
        "value": 0.0053
      },
      "threshold": null
    }
  ],
  "report": {
    "id": "3",
    "name": "用户报表",
    "alias": "user"
  }
}
```

**数据解读**：
- 当前值：624.33万（valueUnit=1，整数）
- 同比（yoy）：+0.53%（unit=2，比率变化），上升，箭头向上
- 环比（mom）：+0.53%（unit=2，比率变化），上升，箭头向上
- 阈值配置：null（无阈值配置）
- 中文单位："万"

## 3. 获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator activeMemberNum
```

输出示例（最近几日）：
```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorName": "活跃用户数"
  },
  "grouping": "ctime",
  "rows": [
    { "period": "2026/05/22", "current": 617.5311, "compare": 605.4536, "unit": "万" },
    { "period": "2026/05/23", "current": 621.0609, "compare": 605.0305, "unit": "万" },
    { "period": "2026/05/24", "current": 624.3347, "compare": 608.0375, "unit": "万" }
  ]
}
```

**趋势特征**：30天数据显示当前值持续高于去年同期（compare），整体呈稳步上升趋势，近3天从617.53万升至624.33万。

## 4. 获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator activeMemberNum
```

输出示例：
```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeId": "manageAreaId",
    "storeTypeName": "管理区域",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)"
  },
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01", "name": "粤西",
      "current": 220.3288, "unit": "万",
      "mom": { "status": "up", "unit": 2, "value": 0.0049 },
      "yoy": { "status": "up", "unit": 2, "value": 0.0018 }
    },
    {
      "code": "CN18", "name": "粤东",
      "current": 182.2334, "unit": "万",
      "mom": { "status": "up", "unit": 2, "value": 0.0054 },
      "yoy": { "status": "up", "unit": 2, "value": 0.0037 }
    },
    {
      "code": "CN15", "name": "华东",
      "current": 34.7446, "unit": "万",
      "mom": { "status": "up", "unit": 2, "value": 0.0047 },
      "yoy": { "status": "up", "unit": 2, "value": 0.0101 }
    },
    {
      "code": "CN07", "name": "运营直管",
      "current": 1.4854, "unit": "万",
      "mom": { "status": "up", "unit": 2, "value": 0.0120 },
      "yoy": { "status": "up", "unit": 2, "value": 0.0097 }
    }
  ],
  "sort": { "field": "current", "order": "DESC" }
}
```

**区域排名**（按当前值降序）：
1. 粤西（CN01）：220.33万，环比+0.49%，同比+0.18%
2. 粤东（CN18）：182.23万，环比+0.54%，同比+0.37%
3. 华东（CN15）：34.74万，环比+0.47%，同比+1.01%
4. 运营直管（CN07）：1.49万，环比+1.20%，同比+0.97%

## 5. 过滤条件说明

- **时间过滤**：通过 `--period-type` 和 `--period-value` 指定分析周期（默认最近一天）。
- **区域过滤**：通过 `--area-type` 和 `--area` 指定下钻区域。默认 `--area-type manageAreaId --area CN00`（全国不含港澳）。
- **显示模式**：通过 `--display-mode` 控制；`yoyMom` 返回同比环比数据。
- **品类过滤**：用户报表 `/report/3` 不支持品类过滤，不要尝试使用 `--category-type` 或 `--category` 参数。
- **不支持的参数**：不要使用 `--store-type`、`--category-type`、`--category`。

## 6. 完整示例

### 示例1：全国活跃用户数整体概览

```bash
# 获取指标详情
qdm-cmr-cli indicator detail --code activeMemberNum --full

# 获取指标值（含同比环比）
qdm-cmr-cli report user indicators --indicator activeMemberNum --display-mode yoyMom

# 获取趋势数据
qdm-cmr-cli report user trend --indicator activeMemberNum

# 获取区域数据
qdm-cmr-cli report user area --indicator activeMemberNum
```

### 示例2：粤西区域下钻分析

```bash
qdm-cmr-cli report user indicators --indicator activeMemberNum --area-type manageAreaId --area CN01 --display-mode yoyMom
qdm-cmr-cli report user trend --indicator activeMemberNum --area-type manageAreaId --area CN01
qdm-cmr-cli report user area --indicator activeMemberNum --area-type manageAreaId --area CN01
```

### 示例3：粤东区域下钻分析

```bash
qdm-cmr-cli report user indicators --indicator activeMemberNum --area-type manageAreaId --area CN18 --display-mode yoyMom
qdm-cmr-cli report user trend --indicator activeMemberNum --area-type manageAreaId --area CN18
```

### 示例4：活跃用户数及其子指标联动

```bash
# 获取活跃用户数
qdm-cmr-cli report user indicators --indicator activeMemberNum --display-mode yoyMom

# 获取子指标：新消费用户数
qdm-cmr-cli report user indicators --indicator firstTranMemberNum --display-mode yoyMom

# 获取子指标：普通活跃会员数
qdm-cmr-cli report user indicators --indicator regularActiveMemberNum --display-mode yoyMom

# 获取子指标：vip1活跃会员数
qdm-cmr-cli report user indicators --indicator vip1ActiveMemberNum --display-mode yoyMom

# 获取子指标：休眠期会员数
qdm-cmr-cli report user indicators --indicator dormantMemberNum --display-mode yoyMom

# 获取子指标：流失期用户数
qdm-cmr-cli report user indicators --indicator churnedMemberNum --display-mode yoyMom
```

## 7. 注意事项

- 活跃用户数是一级核心指标，在报告的第二章（核心指标总览）和第三章（用户规模与分层结构维度深度拆解）中固定展示。
- 用户报表 `/report/3` 不支持品类过滤，不要在命令中使用 `--category-type` 或 `--category` 参数。
- 该指标及其子指标全部归入"用户规模与分层结构"维度，不得放入第四章（会员价值与复购转化）或第五章（用户触达与渠道效率）。
- 活跃用户数的下钻指标较多，报告时需根据指标层级合理组织内容结构：先展示新消费用户数及其子指标，再展示各VIP层级会员数及消费质量指标，最后展示休眠期/流失期/可触达用户数。
- valueUnit=1 表示整数，zhCNUnit="万" 表示单位为万。
- 同比/环比 unit=2 表示比率变化，需乘以 100 转为百分比展示。
- 当 CLI 没有返回某个子指标的值时（如无交易数据期间），报告应直接省略该指标行，不可填 0。
- 趋势数据中 `current` 为当前期值，`compare` 为去年同期值；区域数据中 `compare1Value` 为上期值，`compare2Value` 为上年同期值。