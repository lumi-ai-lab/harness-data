# 物流费额指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取物流费额（`companyLogisticsFee`）指标的详情和趋势数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyLogisticsFee --full
```

返回字段：`indicatorsName`（物流费额）、`indicatorsCodeEn`（companyLogisticsFee）、`businessDefinition`（供应链出库仓配到店产生的物流费用，对应财报的供应链-物流费）、`statisticalLogic`（null）。

---

## 二、获取指标值（含同比、环比）

```bash
qdm-cmr-cli report company indicators --indicator companyLogisticsFee --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **注意**：`report company indicators` 返回的是公司报表的全部核心指标列表，非单指标过滤。需从返回的 `items` 数组中按 `indicatorCode` 筛选目标指标。当前物流费额可能不在该命令的返回结果中，请以 `report company trend` 为趋势分析的主要数据源。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值
- `valueUnit: 2` — 金额值（直接用值，单位：元）
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyLogisticsFee
```

返回最近约 30 天的逐日物流费额数据（current）和同比对照数据（compare）：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeName": "管理区域",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "companyLogisticsFee",
    "indicatorName": "额"
  },
  "grouping": "ctime",
  "report": {
    "id": "4",
    "name": "公司报表",
    "alias": "company"
  },
  "rows": [
    {
      "period": "2026/04/25",
      "current": 665551.43,
      "compare": 601986.41
    },
    {
      "period": "2026/04/26",
      "current": 649460.10,
      "compare": 655539.75
    },
    {
      "period": "2026/04/27",
      "current": 589276.14,
      "compare": 614843.57
    },
    {
      "period": "2026/04/30",
      "current": 800739.49,
      "compare": 605911.23
    },
    {
      "period": "2026/05/10",
      "current": 665130.18,
      "compare": 651486.01
    },
    {
      "period": "2026/05/16",
      "current": 657163.20,
      "compare": 605413.20
    },
    {
      "period": "2026/05/23",
      "current": 182342.89,
      "compare": 603994.98
    },
    {
      "period": "2026/05/24",
      "current": 175808.64,
      "compare": 680087.37
    }
  ]
}
```

> 注：`compare` 为去年同期值，`current` 为当期值，单位：元。以上为节选，实际返回 30 行。物流费额日常在 50 万~80 万元区间波动，5 月 23~24 日出现显著下降。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyLogisticsFee
```

当前物流费额在公司报表的 `area` 命令中返回空结果（`rows: []`），该类费用金额指标的区域拆解数据需通过结合母指标（运输费率）的区域表现间接分析。

---

## 五、过滤条件说明

### 5.1 时间过滤

| 参数 | 格式 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--week` | `YYYY-NN` | `--week 2026-21` | 指定周（ISO 周号） |
| `--month` | `YYYY-MM` | `--month 2026-05` | 指定月份 |

> 公司报表不支持 `--date`（日维度），只支持周、月粒度。**默认**：不传任何时间参数时，取昨天日期。

### 5.2 区域过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--area-type` | `管理区域` / `督导` / `大区` 等 | `--area-type 管理区域` | 区域维度类型 |
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 华东` | 具体区域 |

- `--area-type` 和 `--area` 必须**成对使用**，不能只传一个。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。

### 5.3 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

---

## 六、完整示例

### 示例 1：默认查询（全国、昨天、趋势）

```bash
qdm-cmr-cli report company trend \
  --indicator companyLogisticsFee
```

### 示例 2：指定周 + 全国

```bash
qdm-cmr-cli report company trend \
  --indicator companyLogisticsFee \
  --week 2026-21
```

### 示例 3：月度汇总

```bash
qdm-cmr-cli report company trend \
  --indicator companyLogisticsFee \
  --month 2026-05
```

### 示例 4：结合费率指标联动查询

```bash
# 金额趋势
qdm-cmr-cli report company trend \
  --indicator companyLogisticsFee

# 费率趋势（同一时间口径）
qdm-cmr-cli report company trend \
  --indicator companyLogisticsFeeRate
```

---

## 七、注意事项

1. 公司报表只支持周、月时间粒度；禁止使用 `--date`（日维度）。
2. 品类维度不可选，禁止传入 `--category-type` 或 `--category`。
3. `report company area` 对费用金额指标可能返回空数据，区域分析建议通过费率指标间接进行。
4. 物流费额（`companyLogisticsFee`）是运输费率（`companyLogisticsFeeRate`）的金额子指标，建议联动查询以获得完整的"率+额"视图。
5. 业务定义为"供应链出库仓配到店产生的物流费用，对应财报的供应链-物流费"，关注与出库总额的联动变化。
6. 所有数据均来自 `qdm-cmr-cli report company`，报告 `/report/4` 对应公司报表页面。