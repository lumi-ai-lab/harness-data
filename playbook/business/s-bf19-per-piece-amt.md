# 19点前件单价指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取19点前件单价（`bf19PerPieceAmt`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code bf19PerPieceAmt --full
```

返回字段：`indicatorsName`（19点前件单价）、`businessDefinition`（清仓时段前每件商品的平均售价）、`statisticalLogic`（19点前销售额 / 19点前销售件数）、`indicatorBiz`（销售经营）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator bf19PerPieceAmt --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "bf19PerPieceAmt",
  "indicatorName": "19点前件单价",
  "value": 8.011351819945194,
  "valueUnit": 2,
  "mom": {
    "value": -0.0504,
    "arrowStatus": "up",
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": -0.0884,
    "arrowStatus": "up",
    "status": "up",
    "unit": 2
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 8.01 表示19点前件单价为 8.01 元）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 `-0.0504` 表示 -5.04%，`-0.0884` 表示 -8.84%）
- `unit: 3` — 小数形式的比率变化（百分点变化）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator bf19PerPieceAmt
```

返回最近约 30 天的逐日19点前件单价数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    {
      "period": "2026/05/24",
      "current": 8.011351819945197,
      "compare": 9.269346431702642
    },
    {
      "period": "2026/05/23",
      "current": 8.436594434977106,
      "compare": 8.13287782302643
    },
    {
      "period": "2026/05/22",
      "current": 7.303329675219572,
      "compare": 8.124831544868698
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator bf19PerPieceAmt
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的19点前件单价排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 9.148912812730803,
      "yoy": { "value": -0.004351, "unit": 2 },
      "mom": { "value": -0.069278, "unit": 2 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 8.525976579826715,
      "yoy": { "value": -0.017711, "unit": 2 },
      "mom": { "value": 0.068812, "unit": 2 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 8.441321575667345,
      "yoy": { "value": -0.000271, "unit": 2 },
      "mom": { "value": -0.069027, "unit": 2 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 7.997250048534265,
      "yoy": { "value": 0.024099, "unit": 2 },
      "mom": { "value": -0.106462, "unit": 2 }
    }
  ],
  "sort": { "field": "current", "order": "DESC" }
}
```

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator bf19PerPieceAmt
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类19点前件单价排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 23.498725657723767,
      "yoy": { "value": -0.018643, "unit": 2 },
      "mom": { "value": 0.032186, "unit": 2 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 18.76168077995646,
      "yoy": { "value": -0.042188, "unit": 2 },
      "mom": { "value": -0.099041, "unit": 2 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 17.28033837749142,
      "yoy": { "value": 0.019547, "unit": 2 },
      "mom": { "value": -0.001227, "unit": 2 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 15.553126219742712,
      "yoy": { "value": -0.008551, "unit": 2 },
      "mom": { "value": -0.001450, "unit": 2 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 13.706608853610055,
      "yoy": { "value": -0.016258, "unit": 2 },
      "mom": { "value": -0.282809, "unit": 2 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 5.591315105457594,
      "yoy": { "value": -0.089964, "unit": 2 },
      "mom": { "value": -0.010199, "unit": 2 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 3.453156409479209,
      "yoy": { "value": -0.078826, "unit": 2 },
      "mom": { "value": 0.006597, "unit": 2 }
    }
  ],
  "sort": { "field": "current", "order": "DESC" }
}
```

---

## 六、过滤条件说明

### 6.1 时间过滤

| 参数 | 格式 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--date` | `YYYY-MM-DD` | `--date 2026-05-24` | 指定日期（默认：昨天） |
| `--week` | `YYYY-NN` | `--week 2026-21` | 指定周（ISO 周号） |
| `--month` | `YYYY-MM` | `--month 2026-05` | 指定月份 |

> 三个时间参数互斥，只能使用其中一个。**默认**：不传任何时间参数时，取昨天日期。

### 6.2 区域过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--area-type` | `管理区域` / `督导` / `大区` / `门店` 等 | `--area-type 管理区域` | 区域维度类型 |
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 华东` | 具体区域 |

- `--area-type` 和 `--area` 必须**成对使用**，不能只传一个。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。
- 常见 `--area-type` 映射：
  - `管理区域` -> `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` -> `groupManagerId`
  - `大区` -> `manageRegionId`
  - `门店` -> `storeId`

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 猪肉` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` -> `categoryLevel1Id`（如 12 水果、13 猪肉、10 蔬菜、11 水产、24 肉禽蛋、25 预制菜、26 冷藏加工）
  - `中分类` -> `categoryLevel2Id`
  - `小分类` -> `categoryLevel3Id`
  - `商品` -> `articleId`
- 品类过滤与下钻：当指定大分类后，`area` 和 `category` 子命令会在此品类范围内进一步下钻。

### 6.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

---

## 七、完整示例

### 示例 1：默认查询（全国、全品类、昨天、含同比环比）

```bash
qdm-cmr-cli report business indicators \
  --indicator bf19PerPieceAmt \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 猪肉品类 + 全量数据

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator bf19PerPieceAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator bf19PerPieceAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator bf19PerPieceAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13

# 品类表现（在猪肉范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator bf19PerPieceAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator bf19PerPieceAmt \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator bf19PerPieceAmt \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 2** 表示金额类值，直接使用。例如 `value: 8.01` 表示19点前件单价为 8.01 元。
2. **同比/环比 unit: 2** 表示比率变化。如 `mom.value: -0.0504` 表示环比下降 5.04%；`yoy.value: -0.0884` 表示同比下降 8.84%。
3. **阈值**：该指标无阈值配置（`threshold: null`），无需进行阈值判断。
4. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`arrowStatus` 同 `status`。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。