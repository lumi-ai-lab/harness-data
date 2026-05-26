# 费率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取费率（`companyTotalFeeRate`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyTotalFeeRate --full
```

返回字段：`indicatorsName`（费率）、`businessDefinition`（公司总的费用支出占公司收入的占比）、`statisticalLogic`（暂无详细统计逻辑说明）。

**真实返回示例（2026-05-24）**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "公司总的费用支出占公司收入的占比",
    "indicatorsCodeEn": "companyTotalFeeRate",
    "indicatorsName": "费率",
    "id": "1980915654158880982",
    "statisticalLogic": null
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator companyTotalFeeRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **公司报表不支持品类维度**，禁止传入 `--category-type` 或 `--category`。

### 返回数据结构

该 CLI 返回公司报表的全部指标集。费率（`companyTotalFeeRate`）作为一级核心 showTable 指标，当前 CLI 版本在 `items` 中**未返回独立的 companyTotalFeeRate 条目**。

费率（companyTotalFeeRate）有配套的金额 subIndicator：`companyTotalFee`（总费用额，归入"额"条目）。

**额（companyTotalFee / companyOtherFee）**：

```json
{
  "indicatorCode": "companyOtherFee",
  "indicatorName": "额",
  "value": 28960.86250249247,
  "valueUnit": 2,
  "mom": {
    "value": -0.932,
    "status": "down",
    "unit": 2
  },
  "yoy": {
    "value": -0.9432,
    "status": "down",
    "unit": 2
  }
}
```

- 额当前值约 28,960.86，mom: -0.932（环比下降 93.2%），yoy: -0.9432（同比下降 94.32%）。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyTotalFeeRate
```

**真实返回示例（2026-05-24）**：

近 30 天费率日趋势数据（2026/04/25 ~ 2026/05/24），value 为小数比率（需 *100 转百分比）：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "companyTotalFeeRate",
    "indicatorName": "费率"
  },
  "grouping": "ctime",
  "rows": [
    {
      "compare": 0.1090,
      "current": 0.0815,
      "period": "2026/04/25"
    },
    {
      "compare": 0.0975,
      "current": 0.0819,
      "period": "2026/04/26"
    },
    {
      "compare": 0.0944,
      "current": 0.1353,
      "period": "2026/04/27"
    },
    {
      "compare": 0.2921,
      "current": 0.0822,
      "period": "2026/04/28"
    },
    {
      "compare": 0.1201,
      "current": 0.1082,
      "period": "2026/04/29"
    },
    {
      "compare": 0.2397,
      "current": 0.3677,
      "period": "2026/04/30"
    },
    {
      "compare": 0.0776,
      "current": 0.0873,
      "period": "2026/05/01"
    },
    {
      "compare": 0.0883,
      "current": 0.0979,
      "period": "2026/05/02"
    },
    {
      "compare": 0.0872,
      "current": 0.0961,
      "period": "2026/05/03"
    },
    {
      "compare": 0.0896,
      "current": 0.1018,
      "period": "2026/05/04"
    },
    {
      "compare": 0.0848,
      "current": 0.0993,
      "period": "2026/05/05"
    },
    {
      "compare": 0.1023,
      "current": 0.1016,
      "period": "2026/05/06"
    },
    {
      "compare": 0.1136,
      "current": 0.0602,
      "period": "2026/05/07"
    },
    {
      "compare": 0.0805,
      "current": 0.1002,
      "period": "2026/05/08"
    },
    {
      "compare": 0.1014,
      "current": 0.1001,
      "period": "2026/05/09"
    },
    {
      "compare": 0.0693,
      "current": 0.0761,
      "period": "2026/05/10"
    },
    {
      "compare": 0.0706,
      "current": 0.1757,
      "period": "2026/05/11"
    },
    {
      "compare": 0.1091,
      "current": 0.1071,
      "period": "2026/05/12"
    },
    {
      "compare": 0.1100,
      "current": 0.1258,
      "period": "2026/05/13"
    },
    {
      "compare": 0.1040,
      "current": 0.1097,
      "period": "2026/05/14"
    },
    {
      "compare": 0.1024,
      "current": 0.1069,
      "period": "2026/05/15"
    },
    {
      "compare": 0.0953,
      "current": 0.0822,
      "period": "2026/05/16"
    },
    {
      "compare": 0.0675,
      "current": 0.0848,
      "period": "2026/05/17"
    },
    {
      "compare": 0.0723,
      "current": 0.1289,
      "period": "2026/05/18"
    },
    {
      "compare": 0.0959,
      "current": 0.1038,
      "period": "2026/05/19"
    },
    {
      "compare": 0.0877,
      "current": 0.1077,
      "period": "2026/05/20"
    },
    {
      "compare": 0.1153,
      "current": 0.1379,
      "period": "2026/05/21"
    },
    {
      "compare": 0.0950,
      "current": 0.1238,
      "period": "2026/05/22"
    },
    {
      "compare": 0.0952,
      "current": 0.0580,
      "period": "2026/05/23"
    },
    {
      "compare": 0.0723,
      "current": 0.0434,
      "period": "2026/05/24"
    }
  ]
}
```

**趋势分析要点**：

近 30 天（2026/04/25 ~ 2026/05/24）费率（小数比率）波动区间：

- **最高费率日**：2026/04/30 当期 0.3677（36.77%），为异常高峰值。
- **最低费率日**：2026/05/24 当期 0.0434（4.34%），为近期最低值。
- **费率中位区间**：多数日期费率在 8% ~ 14% 之间波动。
- **05/24 当前值 4.34%**，低于近 30 天均值，也低于同比（7.23%）。
- 04/30 出现异常高峰（36.77%），可能是月末费用集中入账导致。
- 05/11 也出现较高值（17.57%），需要关注是否为特殊费用事件。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyTotalFeeRate
```

**真实返回示例（2026-05-24）**：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "companyTotalFeeRate",
    "indicatorName": "费率"
  },
  "grouping": "storeId",
  "rows": [],
  "sort": {
    "field": "current",
    "order": "DESC"
  }
}
```

- 区域数据返回空数组 `rows: []`，表示费率暂不支持按区域维度拆解。

---

## 五、过滤条件

- 公司报表只支持周、月时间粒度，禁止使用日维度。
- 禁止对 company 报表传入 `--date`。
- 区域维度可选，费率暂不支持区域拆解（area 返回空 rows）。
- 品类维度不可选，禁止传入 `--category-type` 或 `--category`。

## 六、完整示例

```bash
# 基础指标值
qdm-cmr-cli report company indicators --indicator companyTotalFeeRate --display-mode yoyMom

# 趋势分析
qdm-cmr-cli report company trend --indicator companyTotalFeeRate

# 区域表现
qdm-cmr-cli report company area --indicator companyTotalFeeRate
```

## 七、注意事项

- 公司报表使用 `report company` 子命令，非 `report business`。
- 费率是一级核心 showTable 指标，有配套的金额 subIndicator：`companyTotalFee`。
- 当前 CLI 不直接返回 companyTotalFeeRate 的独立 indicators 条目，但 trend 接口返回了丰富的日度趋势数据。
- 费率 trend 数据为小数比率，需 *100 转为百分比展示。
- 04/30 的 36.77% 为异常值，报告时应注明可能是月末费用集中入账。
- valueUnit: 2 表示小数比率值，zhCNUnit 为空。