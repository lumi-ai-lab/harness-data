# 其他业务收支净额指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取其他业务收支净额（`otherBusinessProfit`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code otherBusinessProfit --full
```

返回字段：`indicatorsName`（其他业务收支净额）、`businessDefinition`（其他业务收支净额）、`statisticalLogic`（暂无详细统计逻辑说明）。

**真实返回示例（2026-05-24）**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "其他业务收支净额",
    "indicatorsCodeEn": "otherBusinessProfit",
    "indicatorsName": "其他业务收支净额",
    "id": "2054518046344744960",
    "statisticalLogic": null
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator otherBusinessProfit --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **公司报表不支持品类维度**，禁止传入 `--category-type` 或 `--category`。

### 返回数据结构

该 CLI 返回公司报表的全部指标集。其他业务收支净额（`otherBusinessProfit`）作为收入结构的叶子指标，当前 CLI 版本在 `items` 中**未返回独立的 otherBusinessProfit 条目**，其数据可能聚合在父指标 `companyBusinessIncome`（公司营业收入）中。

如果在报告生成时 CLI 未返回该指标数据，应按 contracts 规范省略该行，不写缺失说明，不保留占位符。

**公司营业收入父指标数据（供参考）**：

```json
{
  "indicatorCode": "companyBusinessIncome",
  "indicatorName": "公司营业收入",
  "value": 3183.4,
  "valueUnit": 2,
  "zhCNUnit": "万",
  "mom": {
    "value": -0.0878,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.0025,
    "status": "up",
    "unit": 2
  }
}
```

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator otherBusinessProfit
```

**真实返回示例（2026-05-24）**：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "otherBusinessProfit",
    "indicatorName": "其他业务收支净额"
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
- 说明该指标在当前统计周期内暂无业务数据。
- 趋势图中呈现为一条水平零线，无波动。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator otherBusinessProfit
```

**真实返回示例（2026-05-24）**：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "otherBusinessProfit",
    "indicatorName": "其他业务收支净额"
  },
  "grouping": "storeId",
  "rows": [],
  "sort": {
    "field": "current",
    "order": "DESC"
  }
}
```

- 区域数据返回空数组 `rows: []`，表示各区域暂无其他业务收支净额的分区数据。

## 五、过滤条件

- 公司报表只支持周、月时间粒度，禁止使用日维度。
- 禁止对 company 报表传入 `--date`。
- 区域维度可选，用户未指定时不强制追加。
- 品类维度不可选，禁止传入 `--category-type` 或 `--category`。

## 六、完整示例

```bash
# 基础指标值
qdm-cmr-cli report company indicators --indicator otherBusinessProfit --display-mode yoyMom

# 趋势分析
qdm-cmr-cli report company trend --indicator otherBusinessProfit

# 区域表现
qdm-cmr-cli report company area --indicator otherBusinessProfit
```

## 七、注意事项

- 公司报表使用 `report company` 子命令，非 `report business`。
- 其他业务收支净额是公司营业收入的子指标，当前 CLI 未返回独立条目，报告生成时若缺失则省略该行。
- 趋势和区域数据当前均为零值，属于正常现象（该指标在系统中暂无活跃数据）。
- valueUnit: 2 表示数值直接使用，zhCNUnit 为"万"时需标注单位。