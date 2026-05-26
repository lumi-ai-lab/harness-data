---
id: member-s-first-tran-member-num
kind: playbook
domain: member
title: 新消费用户数报告生成指引
tags:
  - report
  - playbook
  - user-report
  - firstTranMemberNum
  - 新消费用户数
match:
  keywords:
    - 新消费用户数
    - 新消费用户数报告
    - 新消费用户数玩法
    - firstTranMemberNum报告
---

# 新消费用户数报告生成指引

> 命令使用 `qdm-cmr-cli report user`，获取用户报表 `/report/3` 的新消费用户数指标分析。

## 1. 获取指标详情

```bash
qdm-cmr-cli indicator detail --code firstTranMemberNum --full
```

输出示例：
```json
{
  "indicatorsName": "新消费会员数",
  "indicatorsCodeEn": "firstTranMemberNum",
  "businessDefinition": "用户的历史首次消费时间处于统计周期内的用户数",
  "statisticalLogic": "统计周期内，产生了首次消费的会员id计数"
}
```

## 2. 获取指标值（含同比环比）

```bash
qdm-cmr-cli report user indicators --indicator firstTranMemberNum --display-mode yoyMom
```

输出示例（新消费用户数核心值）：
```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeId": "manageAreaId",
    "storeTypeName": "管理区域",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "firstTranMemberNum",
    "indicatorName": "新消费用户数",
    "displayMode": "yoyMom"
  },
  "items": [
    {
      "indicatorCode": "firstTranMemberNum",
      "indicatorName": "新消费用户数",
      "value": 13163,
      "valueUnit": 1,
      "zhCNUnit": "",
      "yoy": {
        "arrowStatus": "up",
        "status": "up",
        "unit": 2,
        "value": 1.051
      },
      "mom": {
        "arrowStatus": "up",
        "status": "up",
        "unit": 2,
        "value": -0.0187
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
- 当前值：13163（valueUnit=1，整数，无中文单位）
- 同比（yoy）：+105.1%（unit=2，比率变化），大幅上升
- 环比（mom）：-1.87%（unit=2，比率变化），小幅下降
- 阈值配置：null（无阈值配置）

## 3. 获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator firstTranMemberNum
```

输出示例（最近几日）：
```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorName": "新消费用户数"
  },
  "grouping": "ctime",
  "rows": [
    { "period": "2026/05/22", "current": 9081, "compare": 6815 },
    { "period": "2026/05/23", "current": 13414, "compare": 6803 },
    { "period": "2026/05/24", "current": 13163, "compare": 10485 }
  ]
}
```

**趋势特征**：新消费用户数呈现明显波动特征，有周期性高峰（如5月12日12859、5月19日12200、5月23日13414）。当前值13163，高于去年同期10485。

## 4. 获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator firstTranMemberNum
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
      "current": 3304,
      "mom": { "status": "up", "unit": 2, "value": -0.0314 },
      "yoy": { "status": "up", "unit": 2, "value": 0.7217 }
    },
    {
      "code": "CN18", "name": "粤东",
      "current": 2575,
      "mom": { "status": "up", "unit": 2, "value": -0.0190 },
      "yoy": { "status": "up", "unit": 2, "value": 0.7352 }
    },
    {
      "code": "CN15", "name": "华东",
      "current": 1008,
      "mom": { "status": "up", "unit": 2, "value": -0.0473 },
      "yoy": { "status": "up", "unit": 2, "value": 1.7616 }
    },
    {
      "code": "CN07", "name": "运营直管",
      "current": 21,
      "mom": { "status": "up", "unit": 2, "value": -0.3226 },
      "yoy": { "status": "up", "unit": 2, "value": 3.2 }
    }
  ],
  "sort": { "field": "current", "order": "DESC" }
}
```

**区域排名**（按当前值降序）：
1. 粤西（CN01）：3304，环比-3.14%，同比+72.17%
2. 粤东（CN18）：2575，环比-1.90%，同比+73.52%
3. 华东（CN15）：1008，环比-4.73%，同比+176.16%
4. 运营直管（CN07）：21，环比-32.26%，同比+320%

## 5. 过滤条件说明

- **时间过滤**：通过 `--period-type` 和 `--period-value` 指定分析周期（默认最近一天）。
- **区域过滤**：通过 `--area-type` 和 `--area` 指定下钻区域。默认 `--area-type manageAreaId --area CN00`（全国不含港澳）。
- **显示模式**：通过 `--display-mode` 控制；`yoyMom` 返回同比环比数据。
- **品类过滤**：用户报表 `/report/3` 不支持品类过滤，不要尝试使用 `--category-type` 或 `--category` 参数。
- **不支持的参数**：不要使用 `--store-type`、`--category-type`、`--category`。

## 6. 完整示例

### 示例1：全国新消费用户数整体概览

```bash
# 获取指标详情
qdm-cmr-cli indicator detail --code firstTranMemberNum --full

# 获取指标值（含同比环比）
qdm-cmr-cli report user indicators --indicator firstTranMemberNum --display-mode yoyMom

# 获取趋势数据
qdm-cmr-cli report user trend --indicator firstTranMemberNum

# 获取区域数据
qdm-cmr-cli report user area --indicator firstTranMemberNum
```

### 示例2：粤西区域新消费用户数分析

```bash
qdm-cmr-cli report user indicators --indicator firstTranMemberNum --area-type manageAreaId --area CN01 --display-mode yoyMom
qdm-cmr-cli report user trend --indicator firstTranMemberNum --area-type manageAreaId --area CN01
```

### 示例3：华东区域新消费用户数分析

```bash
qdm-cmr-cli report user indicators --indicator firstTranMemberNum --area-type manageAreaId --area CN15 --display-mode yoyMom
qdm-cmr-cli report user trend --indicator firstTranMemberNum --area-type manageAreaId --area CN15
```

### 示例4：新消费用户数及其子指标联动

```bash
# 获取新消费用户数
qdm-cmr-cli report user indicators --indicator firstTranMemberNum --display-mode yoyMom

# 获取子指标：新客首单客单价
qdm-cmr-cli report user indicators --indicator firstTranMemberPerCustAmt --display-mode yoyMom

# 获取子指标：次月留存率
qdm-cmr-cli report user indicators --indicator nextMonthRetainedRate --display-mode yoyMom
```

## 7. 注意事项

- 新消费用户数是活跃用户数的子指标，固定放入报告第三章"用户规模与分层结构维度深度拆解"的新用户表现指标组。
- 用户报表 `/report/3` 不支持品类过滤，不要在命令中使用 `--category-type` 或 `--category` 参数。
- 该指标及其子指标全部归入"用户规模与分层结构"维度，不得放入第四章或第五章。
- 新消费用户数数据具有明显周期性波动特征，分析时需注意区分周期性因素和趋势性变化。
- valueUnit=1 表示整数，zhCNUnit="" 表示无中文单位前缀（直接以"人"或"个"为单位）。
- 同比/环比 unit=2 表示比率变化，需乘以 100 转为百分比展示。
- 当 CLI 没有返回该指标的值时，报告应直接省略该指标行，不可填 0。
- 趋势数据中 `current` 为当前期值，`compare` 为去年同期值；区域数据中 `compare1Value` 为上期值，`compare2Value` 为上年同期值。