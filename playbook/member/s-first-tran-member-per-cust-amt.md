---
id: member-s-first-tran-member-per-cust-amt
kind: playbook
domain: member
title: 新客首单客单价报告生成指引
tags:
  - report
  - playbook
  - user-report
  - firstTranMemberPerCustAmt
  - 新客首单客单价
match:
  keywords:
    - 新客首单客单价
    - 新客首单客单价报告
    - 新客首单客单价玩法
    - firstTranMemberPerCustAmt报告
---

# 新客首单客单价报告生成指引

> 命令使用 `qdm-cmr-cli report user`，获取用户报表 `/report/3` 的新客首单客单价指标分析。

## 1. 获取指标详情

```bash
qdm-cmr-cli indicator detail --code firstTranMemberPerCustAmt --full
```

输出示例：
```json
{
  "indicatorsName": "新客首单客单价",
  "indicatorsCodeEn": "firstTranMemberPerCustAmt",
  "businessDefinition": "统计周期内，首次消费会员的首笔订单的平均消费金额",
  "statisticalLogic": "新客首次消费销售额 / 新消费会员数"
}
```

## 2. 获取指标值（含同比环比）

```bash
qdm-cmr-cli report user indicators --indicator firstTranMemberPerCustAmt --display-mode yoyMom
```

输出示例（新客首单客单价核心值）：
```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeId": "manageAreaId",
    "storeTypeName": "管理区域",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "firstTranMemberPerCustAmt",
    "indicatorName": "新客首单客单价",
    "displayMode": "yoyMom"
  },
  "items": [
    {
      "indicatorCode": "firstTranMemberPerCustAmt",
      "indicatorName": "新客首单客单价",
      "value": 28.536511,
      "valueUnit": 2,
      "zhCNUnit": "",
      "yoy": {
        "arrowStatus": "up",
        "status": "up",
        "unit": 2,
        "value": -0.2614
      },
      "mom": {
        "arrowStatus": "up",
        "status": "up",
        "unit": 2,
        "value": -0.1408
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
- 当前值：28.54元（valueUnit=2，百分比/比率类型但实际为金额值）
- 同比（yoy）：-26.14%（unit=2，比率变化），下降
- 环比（mom）：-14.08%（unit=2，比率变化），下降
- 阈值配置：null（无阈值配置）

## 3. 获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator firstTranMemberPerCustAmt
```

输出示例（最近几日）：
```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorName": "新客首单客单价"
  },
  "grouping": "ctime",
  "rows": [
    { "period": "2026/05/24", "current": 28.536511, "compare": <compare24> }
  ]
}
```

## 4. 获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator firstTranMemberPerCustAmt
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
      "code": "CN15", "name": "华东",
      "current": 31.611021,
      "mom": { "status": "up", "unit": 2, "value": 0.0218 },
      "yoy": { "status": "up", "unit": 2, "value": -0.2717 }
    },
    {
      "code": "CN18", "name": "粤东",
      "current": 29.50019,
      "mom": { "status": "up", "unit": 2, "value": -0.0621 },
      "yoy": { "status": "up", "unit": 2, "value": -0.1943 }
    },
    {
      "code": "CN01", "name": "粤西",
      "current": 28.027,
      "mom": { "status": "up", "unit": 2, "value": -0.2447 },
      "yoy": { "status": "up", "unit": 2, "value": -0.1908 }
    },
    {
      "code": "CN07", "name": "运营直管",
      "current": 25.390952,
      "mom": { "status": "up", "unit": 2, "value": -0.2024 },
      "yoy": { "status": "up", "unit": 2, "value": -0.3156 }
    }
  ],
  "sort": { "field": "current", "order": "DESC" }
}
```

**区域排名**（按当前值降序）：
1. 华东（CN15）：31.61元，环比+2.18%，同比-27.17%
2. 粤东（CN18）：29.50元，环比-6.21%，同比-19.43%
3. 粤西（CN01）：28.03元，环比-24.47%，同比-19.08%
4. 运营直管（CN07）：25.39元，环比-20.24%，同比-31.56%

## 5. 过滤条件说明

- **时间过滤**：通过 `--period-type` 和 `--period-value` 指定分析周期（默认最近一天）。
- **区域过滤**：通过 `--area-type` 和 `--area` 指定下钻区域。默认 `--area-type manageAreaId --area CN00`（全国不含港澳）。
- **显示模式**：通过 `--display-mode` 控制；`yoyMom` 返回同比环比数据。
- **品类过滤**：用户报表 `/report/3` 不支持品类过滤，不要尝试使用 `--category-type` 或 `--category` 参数。
- **不支持的参数**：不要使用 `--store-type`、`--category-type`、`--category`。

## 6. 完整示例

### 示例1：全国新客首单客单价整体概览

```bash
qdm-cmr-cli indicator detail --code firstTranMemberPerCustAmt --full
qdm-cmr-cli report user indicators --indicator firstTranMemberPerCustAmt --display-mode yoyMom
qdm-cmr-cli report user trend --indicator firstTranMemberPerCustAmt
qdm-cmr-cli report user area --indicator firstTranMemberPerCustAmt
```

### 示例2：华东区域下钻分析

```bash
qdm-cmr-cli report user indicators --indicator firstTranMemberPerCustAmt --area-type manageAreaId --area CN15 --display-mode yoyMom
qdm-cmr-cli report user trend --indicator firstTranMemberPerCustAmt --area-type manageAreaId --area CN15
```

### 示例3：粤西区域下钻分析

```bash
qdm-cmr-cli report user indicators --indicator firstTranMemberPerCustAmt --area-type manageAreaId --area CN01 --display-mode yoyMom
qdm-cmr-cli report user trend --indicator firstTranMemberPerCustAmt --area-type manageAreaId --area CN01
```

## 7. 注意事项

- 新客首单客单价是叶子指标，无下钻子指标，报告中仅展示其自身数值和变化趋势。
- 该指标作为新消费用户数的质量指标，在报告中紧跟新消费用户数展示。
- 用户报表 `/report/3` 不支持品类过滤。
- 该指标固定归入第三章"用户规模与分层结构维度深度拆解"的新用户表现指标组，不得放入其他章节。
- valueUnit=2 表示百分比/比率类型。
- 同比/环比 unit=2 表示比率变化，需乘以 100 转为百分比展示。
- 当 CLI 没有返回该指标的值时，报告应直接省略该指标行，不可填 0。
- 区域数据中 `compare1Value` 为上期值，`compare2Value` 为上年同期值。