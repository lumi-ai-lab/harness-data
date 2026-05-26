# 补贴费用率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取补贴费用率（`companyAllowanceFeeRate`）指标的详情和趋势数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyAllowanceFeeRate --full
```

返回字段：`indicatorsName`（补贴费用率）、`indicatorsCodeEn`（companyAllowanceFeeRate）、`businessDefinition`（补贴费用占占公司收入的占比）、`statisticalLogic`（null）。

---

## 二、获取指标值（含同比、环比）

```bash
qdm-cmr-cli report company indicators --indicator companyAllowanceFeeRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **注意**：`report company indicators` 返回的是公司报表的全部核心指标列表，非单指标过滤。需从返回的 `items` 数组中按 `indicatorCode` 筛选目标指标。当前补贴费用率可能不在该命令的返回结果中，请以 `report company trend` 为趋势分析的主要数据源。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 0.0059769 表示 0.5977%）
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyAllowanceFeeRate
```

返回最近约 30 天的逐日补贴费用率数据（current）和同比对照数据（compare）：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeName": "管理区域",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "companyAllowanceFeeRate",
    "indicatorName": "补贴费用率"
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
      "current": 0.005976899814395652,
      "compare": 0.0044952998630603475
    },
    {
      "period": "2026/04/26",
      "current": 0.005004692902382651,
      "compare": 0.0033561818244956794
    },
    {
      "period": "2026/04/27",
      "current": 0.00510319711402429,
      "compare": 0.0033979334691552343
    },
    {
      "period": "2026/04/28",
      "current": 0.011225863106187301,
      "compare": 0.006842105854235168
    },
    {
      "period": "2026/04/29",
      "current": 0.013335748218360725,
      "compare": 0.007529219248257071
    },
    {
      "period": "2026/05/11",
      "current": 0.011304369667307313,
      "compare": 0.0031541837512394184
    },
    {
      "period": "2026/05/15",
      "current": 0.009441352942507834,
      "compare": 0.006366320159935749
    },
    {
      "period": "2026/05/24",
      "current": 0,
      "compare": 0.004655191410389283
    }
  ]
}
```

> 注：`compare` 为去年同期值，`current` 为当期值。以上为节选，实际返回 30 行。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyAllowanceFeeRate
```

当前补贴费用率在公司报表的 `area` 命令中返回空结果（`rows: []`），该类费率指标的区域拆解数据需通过结合母指标（宣传促销补贴费率）的区域表现间接分析。

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

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

---

## 六、完整示例

### 示例 1：默认查询（全国、昨天、趋势）

```bash
qdm-cmr-cli report company trend \
  --indicator companyAllowanceFeeRate
```

### 示例 2：指定周 + 全国

```bash
qdm-cmr-cli report company trend \
  --indicator companyAllowanceFeeRate \
  --week 2026-21
```

### 示例 3：月度汇总 + 华东区域

```bash
qdm-cmr-cli report company trend \
  --indicator companyAllowanceFeeRate \
  --month 2026-05 \
  --area-type 管理区域 --area CN15
```

### 示例 4：结合金额子指标联动查询

```bash
# 费率趋势
qdm-cmr-cli report company trend \
  --indicator companyAllowanceFeeRate

# 金额趋势（同一时间口径）
qdm-cmr-cli report company trend \
  --indicator companyAllowanceFee
```

---

## 七、注意事项

1. 公司报表只支持周、月时间粒度；禁止使用 `--date`（日维度）。
2. 品类维度不可选，禁止传入 `--category-type` 或 `--category`。
3. `report company area` 对费率指标可能返回空数据，区域分析建议通过母指标（宣传促销补贴费率）间接进行。
4. 补贴费用率（`companyAllowanceFeeRate`）与补贴费用额（`companyAllowanceFee`）是子指标关系，建议联动查询以获得完整的"率+额"视图。
5. 所有数据均来自 `qdm-cmr-cli report company`，报告 `/report/4` 对应公司报表页面。