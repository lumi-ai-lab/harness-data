# 公司毛利额指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取公司毛利额（`companyProfit`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyProfit --full
```

返回字段：`indicatorsName`（公司毛利额）、`businessDefinition`（公司毛利额）、`statisticalLogic`（暂无详细统计逻辑说明）。

**真实返回示例（2026-05-24）**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "公司毛利额",
    "indicatorsCodeEn": "companyProfit",
    "indicatorsName": "公司毛利额",
    "id": "2054518046445408257",
    "statisticalLogic": null
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator companyProfit --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **公司报表不支持品类维度**，禁止传入 `--category-type` 或 `--category`。

### 返回数据结构

该 CLI 返回公司报表的全部指标集。公司毛利额（`companyProfit`）作为一级核心 showTable 指标，当前 CLI 版本在 `items` 中**未返回独立的 companyProfit 条目**，但返回了其子指标：

**供应链毛利额（子指标，lineType: dashed）**：

```json
{
  "indicatorCode": "financeScmProfit",
  "indicatorName": "供应链毛利额",
  "value": 0,
  "valueUnit": 2,
  "mom": {
    "value": null,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": null,
    "status": "up",
    "unit": 2
  }
}
```

**直营店毛利额（子指标，lineType: dashed）**：

```json
{
  "indicatorCode": "directStoreProfitAmt",
  "indicatorName": "直营店毛利额",
  "value": 0,
  "valueUnit": 2,
  "mom": {
    "value": -1,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": -1,
    "status": "up",
    "unit": 2
  }
}
```

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyProfit
```

**真实返回示例（2026-05-24）**：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "companyProfit",
    "indicatorName": "公司毛利额"
  },
  "grouping": "ctime",
  "rows": [
    {
      "compare": 0,
      "current": 0,
      "period": "2026/04/25"
    }
    // ... 近30天数据，所有值均为 0
  ]
}
```

**趋势分析要点**：

- 近 30 天（2026/04/25 ~ 2026/05/24）所有数据点的 current 和 compare 均为 0。
- 说明公司毛利额在该统计周期内暂无活跃数据。
- 趋势图中呈现为一条水平零线，无波动。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyProfit
```

**真实返回示例（2026-05-24）**：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "companyProfit",
    "indicatorName": "公司毛利额"
  },
  "grouping": "storeId",
  "rows": [],
  "sort": {
    "field": "current",
    "order": "DESC"
  }
}
```

- 区域数据返回空数组 `rows: []`，表示各区域暂无公司毛利额的分区数据。

---

## 五、过滤条件

- 公司报表只支持周、月时间粒度，禁止使用日维度。
- 禁止对 company 报表传入 `--date`。
- 区域维度可选，用户未指定时不强制追加。
- 品类维度不可选，禁止传入 `--category-type` 或 `--category`。

## 六、完整示例

```bash
# 基础指标值
qdm-cmr-cli report company indicators --indicator companyProfit --display-mode yoyMom

# 趋势分析
qdm-cmr-cli report company trend --indicator companyProfit

# 区域表现
qdm-cmr-cli report company area --indicator companyProfit
```

## 七、注意事项

- 公司报表使用 `report company` 子命令，非 `report business`。
- 公司毛利额是 EBITDA 的一级子指标（showTable），其子指标供应链毛利额和直营店毛利额以 lineType:dashed 显示。
- 当前 CLI 不直接返回 companyProfit 的独立数值，其值由子指标（供应链毛利额 + 直营店毛利额）聚合而成。
- 当前趋势和区域数据均为零值，属于正常现象。
- valueUnit: 2 表示数值直接使用。