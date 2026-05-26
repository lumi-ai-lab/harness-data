# 客单价指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取客单价（`perCustAmt`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code perCustAmt --full
```

返回字段：`indicatorsName`（客单价）、`businessDefinition`（平均每笔订单的订单金额）、`statisticalLogic`（销售额 / 来客数）、`indicatorBiz`（销售经营）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator perCustAmt --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "perCustAmt",
  "indicatorName": "客单价",
  "value": 32.44,
  "valueUnit": 2,
  "mom": {
    "value": -0.0579,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.3529,
    "status": "up",
    "unit": 2
  },
  "threshold": {
    "compareSymbol": "GT",
    "compareValue1": 19.8,
    "compareValue2": 19.8,
    "compareValueType": 2
  }
}
```

**valueUnit = 2 的含义**：金额值，直接使用。如 `value: 32.44` 表示客单价为 32.44 元。

**同比/环比 unit = 2 的含义**：比率变化。如 `mom.value: -0.0579` 表示环比下降 5.79%；`yoy.value: 0.3529` 表示同比上升 35.29%。

**阈值配置**：`compareSymbol: "GT"`（大于），`compareValue1: 19.8`，即客单价阈值目标 >19.8 元。当前值 32.44 达标（32.44 > 19.8）。

**同比/环比中的 status**：`status: "up"` 且 `value: -0.0579` 表示箭头向上但环比数值为负（即环比下降）。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 金额值（直接用值，如 32.44 表示 32.44 元）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 -0.0579 表示 -5.79%）
- `unit: 3` — 小数形式的比率变化（如 0.0007 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator perCustAmt
```

返回最近约 30 天的逐日客单价数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 32.44213412651425,
      "compare": 26.70481579096315
    },
    {
      "period": "2026/05/23",
      "current": 34.435773422628465,
      "compare": 23.686414591810223
    },
    {
      "period": "2026/05/22",
      "current": 28.45403898200447,
      "compare": 22.008903731803453
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator perCustAmt
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的客单价排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 25.967611690810546,
      "yoy": { "value": 0.011158871900718795 },
      "mom": { "value": -0.062351857415911045 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 23.261439212038265,
      "yoy": { "value": 0.009781032296973162 },
      "mom": { "value": -0.07292677767542678 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 22.386,
      "yoy": { "value": 0.031174424878548632 },
      "mom": { "value": -0.10685822015052468 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 22.33151398525178,
      "yoy": { "value": 0.04042977134230109 },
      "mom": { "value": 0.0772057147686073 }
    }
  ]
}
```

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator perCustAmt
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类客单价排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 38.9660288250229,
      "yoy": { "value": 0.33126631001788187 },
      "mom": { "value": 0.008673287155437113 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 27.36618641221506,
      "yoy": { "value": 0.3597465500144843 },
      "mom": { "value": -0.06946414833997003 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 25.74607997328659,
      "yoy": { "value": 0.319878034572701 },
      "mom": { "value": -0.008515799629911088 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 24.682696914387012,
      "yoy": { "value": 0.2735231840422985 },
      "mom": { "value": 0.006509155659119644 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 24.2392007243819,
      "yoy": { "value": 0.257847819615231 },
      "mom": { "value": -0.23670939878882075 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 11.985666539182086,
      "yoy": { "value": 0.2534874617250294 },
      "mom": { "value": -0.005248271027207512 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 10.981054196348305,
      "yoy": { "value": 0.46297746680533136 },
      "mom": { "value": -0.010793768885937135 }
    }
  ]
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
  - `管理区域` → `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东、CN07 运营直管）
  - `督导` → `groupManagerId`
  - `大区` → `manageRegionId`
  - `门店` → `storeId`

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 猪肉` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` → `categoryLevel1Id`（如 12 水果、13 猪肉、10 蔬菜、11 水产、24 肉禽蛋、25 预制菜、26 冷藏加工）
  - `中分类` → `categoryLevel2Id`
  - `小分类` → `categoryLevel3Id`
  - `商品` → `articleId`

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
  --indicator perCustAmt \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 猪肉品类 + 全量数据

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator perCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator perCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator perCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13

# 品类表现（在猪肉范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator perCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13
```

### 示例 3：月度汇总 + 督导区域维度 + 水果品类

```bash
qdm-cmr-cli report business indicators \
  --indicator perCustAmt \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --category-type 大分类 --category 12 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator perCustAmt \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. `valueUnit: 2` 表示金额值，直接使用，无需转换。如 `value: 32.44` 表示客单价为 32.44 元。
2. 同比/环比 `unit: 2` 表示比率变化。如 `mom.value: -0.0579` 表示环比下降 5.79%；`yoy.value: 0.3529` 表示同比上升 35.29%。
3. 阈值目标为 >19.8（`compareSymbol: "GT"`）。当前值 32.44 达标。
4. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.0579` 表示箭头向上但环比下降 5.79%。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。