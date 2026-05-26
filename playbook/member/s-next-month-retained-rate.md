---
id: member-s-next-month-retained-rate
kind: playbook
domain: member
title: 次月留存率报告生成指引
tags:
  - report
  - playbook
  - user-report
  - nextMonthRetainedRate
  - 次月留存率
match:
  keywords:
    - 次月留存率
    - 次月留存率报告
    - 次月留存率玩法
    - nextMonthRetainedRate报告
---

# 次月留存率报告生成指引

> 命令使用 `qdm-cmr-cli report user`，获取用户报表 `/report/3` 的次月留存率指标分析。

## 1. 获取指标详情

```bash
qdm-cmr-cli indicator detail --code nextMonthRetainedRate --full
```

输出示例：
```json
{
  "indicatorsName": "次月留存率",
  "indicatorsCodeEn": "nextMonthRetainedRate",
  "businessDefinition": "上个月的新消费会员，在本月继续消费的会员占比",
  "statisticalLogic": "次月留存会员数 / 上月的新消费会员数"
}
```

## 2. 获取指标值（含同比环比）

```bash
qdm-cmr-cli report user indicators --indicator nextMonthRetainedRate --display-mode yoyMom
```

**重要提示**：该指标在当前数据源中可能无值（CLI 返回 items 中不包含该指标或全为 0）。根据报告合同规范，CLI 未返回有值时报告应省略该指标行。

## 3. 获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator nextMonthRetainedRate
```

输出示例（当前数据可能为空值）：
```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorName": "次月留存率"
  },
  "grouping": "ctime",
  "rows": [
    { "period": "2026/05/24", "current": 0, "compare": 0 }
  ]
}
```

**注意**：当 rows 中 current 和 compare 均为 0 时，表示该指标当前无有效数据，报告中应省略该指标。

## 4. 获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator nextMonthRetainedRate
```

输出示例（当前数据可能为空）：
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
  "rows": [],
  "sort": { "field": "current", "order": "DESC" }
}
```

**注意**：当 rows 为空数组时，表示该指标无区域维度数据，报告中应省略区域排名。

## 5. 过滤条件说明

- **时间过滤**：通过 `--period-type` 和 `--period-value` 指定分析周期（默认最近一天）。
- **区域过滤**：通过 `--area-type` 和 `--area` 指定下钻区域。默认 `--area-type manageAreaId --area CN00`（全国不含港澳）。
- **显示模式**：通过 `--display-mode` 控制；`yoyMom` 返回同比环比数据。
- **品类过滤**：用户报表 `/report/3` 不支持品类过滤，不要尝试使用 `--category-type` 或 `--category` 参数。
- **不支持的参数**：不要使用 `--store-type`、`--category-type`、`--category`。

## 6. 完整示例

### 示例1：全国次月留存率整体概览

```bash
qdm-cmr-cli indicator detail --code nextMonthRetainedRate --full
qdm-cmr-cli report user indicators --indicator nextMonthRetainedRate --display-mode yoyMom
qdm-cmr-cli report user trend --indicator nextMonthRetainedRate
qdm-cmr-cli report user area --indicator nextMonthRetainedRate
```

### 示例2：粤西区域下钻

```bash
qdm-cmr-cli report user indicators --indicator nextMonthRetainedRate --area-type manageAreaId --area CN01 --display-mode yoyMom
```

### 示例3：华东区域下钻

```bash
qdm-cmr-cli report user indicators --indicator nextMonthRetainedRate --area-type manageAreaId --area CN15 --display-mode yoyMom
```

## 7. 注意事项

- 次月留存率是叶子指标，无下钻子指标，报告中仅展示其自身数值和变化趋势。
- **关键规则**：该指标仅在 CLI 返回有值时展示。当前该指标在 indicators 接口中未返回有效值，trend 接口返回全 0，area 接口返回空数组。按报告合同规范，CLI 未返回有值时报告应省略该指标行。
- 用户报表 `/report/3` 不支持品类过滤。
- 该指标固定归入第三章"用户规模与分层结构维度深度拆解"的新用户表现指标组，不得放入其他章节。
- 该指标作为新消费用户数的质量指标，在报告中紧跟新客首单客单价展示。
- 指标配置存在但 CLI 没有返回值，不等于指标值为 0；最终报告应省略无值指标。