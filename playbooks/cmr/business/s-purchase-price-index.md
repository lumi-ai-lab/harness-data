# 采购价格指数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取采购价格指数（`purchasePriceIndex`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code purchasePriceIndex --full
```

返回字段：`indicatorsName`（采购价价格指数）、`businessDefinition`（对标真甜农服的蔬菜采购价价格指数）、`statisticalLogic`（钱大妈商品采购价格 / 竞品商品采购价格）、`indicatorBiz`（未指定）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator purchasePriceIndex --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "purchasePriceIndex",
  "indicatorName": "采购价格指数",
  "value": 92.1868446117098,
  "valueUnit": 2,
  "mom": {
    "value": 2.8655609480317707,
    "status": "down",
    "unit": 1
  },
  "yoy": {
    "value": 92.1868446117098,
    "status": "down",
    "unit": 1
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 92.19 表示采购价格指数为 92.19）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.2646 表示 26.46%）

**同比/环比的 unit**：
- `unit: 1` — 绝对变化量（如 `+2.87` 表示环比上升 2.87 个指数点）
- `unit: 2` — 比率变化（如 `-0.039` 表示 -3.9%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

**采购价格指数的 valueUnit**：`valueUnit: 2`，值为指数数值本身（如 92.19）。
**同比/环比的 unit**：`unit: 1`，值为指数点的绝对变化量（如 mom `+2.87` 表示环比上升 2.87 个指数点）。

**阈值**：无阈值配置（`threshold: null`）。

> 注意：yoy `value: 92.1868446117098` 表示由于去年同期无该指标数据（基期为 0），同比值等于当前值本身（92.19 同比上升 92.19），说明该指标为新上线或去年同期无对标数据。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator purchasePriceIndex
```

返回最近约 30 天的逐日采购价格指数数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 92.1868446117098,
      "compare": 94.35500923856323
    },
    {
      "period": "2026/05/23",
      "current": 89.32128366367803,
      "compare": 94.04574998974343
    },
    {
      "period": "2026/05/22",
      "current": 98.54882101403386,
      "compare": 95.6555130080684
    },
    {
      "period": "2026/05/21",
      "current": 98.94165616243129,
      "compare": 94.97182593111394
    },
    {
      "period": "2026/05/20",
      "current": 0,
      "compare": 96.00267999102847
    }
  ]
}
```

> 注意：趋势数据中存在大量 `current: 0` 的日期（2026/05/02 - 2026/05/20 共 19 天），仅 4/25-5/1 和 5/21-5/24 有有效数据，说明该指标数据覆盖不连续，可能仅在特定条件下有数据返回。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator purchasePriceIndex
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的采购价格指数排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 82.43166580959746,
      "yoy": { "value": 82.43166580959746 },
      "mom": { "value": 1.7022230579337645 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 80.5066575428336,
      "yoy": { "value": 80.5066575428336 },
      "mom": { "value": 3.3614101057629853 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 0,
      "yoy": { "value": 0 },
      "mom": { "value": 0 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": null,
      "yoy": { "value": null },
      "mom": { "value": null }
    }
  ]
}
```

- 所有区域 yoy/mom 的 `unit` 均为 `1`（绝对变化量）。
- 粤东区域阈值：`compareSymbol: "LT"`，`compareValue1: 100`。
- 粤西区域阈值：`compareSymbol: "LT"`，`compareValue1: 100`。

> 注意：华东区域 `current: 0`，运营直管 `current: null`，说明仅粤东、粤西有有效采购价格指数数据。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator purchasePriceIndex
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回各品类的采购价格指数排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "10",
      "name": "蔬菜",
      "current": 92.18684461170972,
      "yoy": { "value": 92.18684461170972 },
      "mom": { "value": 2.8655609480318134 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0,
      "yoy": { "value": 0 },
      "mom": { "value": 0 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 0,
      "yoy": { "value": 0 },
      "mom": { "value": 0 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 0,
      "yoy": { "value": 0 },
      "mom": { "value": 0 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 0,
      "yoy": { "value": 0 },
      "mom": { "value": 0 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0,
      "yoy": { "value": 0 },
      "mom": { "value": 0 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0,
      "yoy": { "value": 0 },
      "mom": { "value": 0 }
    }
  ]
}
```

- 所有品类 yoy/mom 的 `unit` 均为 `1`（绝对变化量）。

> 注意：仅蔬菜品类有有效的采购价格指数数据（92.19），其余 6 个品类（预制菜、猪肉、肉禽蛋、水果、水产、冷藏加工）均为 0。这与业务定义"对标真甜农服的蔬菜采购价价格指数"一致，说明该指标当前仅覆盖蔬菜品类。

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
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 粤东` | 具体区域 |

- `--area-type` 和 `--area` 必须**成对使用**，不能只传一个。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。
- 常见 `--area-type` 映射：
  - `管理区域` → `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` → `groupManagerId`
  - `大区` → `manageRegionId`
  - `门店` → `storeId`

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 蔬菜` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` → `categoryLevel1Id`（如 10 蔬菜、11 水产、12 水果、13 猪肉、24 肉禽蛋、25 预制菜、26 冷藏加工）
  - `中分类` → `categoryLevel2Id`
  - `小分类` → `categoryLevel3Id`
  - `商品` → `articleId`
- 注意：采购价格指数当前仅蔬菜品类有有效数据，其他品类均返回 0。如需品类下钻，建议优先指定 `--category-type 大分类 --category 10`（蔬菜）。

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
  --indicator purchasePriceIndex \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤东区域 + 蔬菜品类

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator purchasePriceIndex \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 10 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator purchasePriceIndex \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 10

# 区域表现（在粤东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator purchasePriceIndex \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 10

# 品类表现（在蔬菜范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator purchasePriceIndex \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 10
```

### 示例 3：查看父指标售价价格指数(线上)

```bash
qdm-cmr-cli report business indicators \
  --indicator priceIndex \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator purchasePriceIndex \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化量；**环比（mom）** = 与上一个周期对比的变化量。采购价格指数的 yoy/mom 的 unit 为 `1`（绝对变化量，指数点）。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。例如 `status: "down"` 且 `value: 2.8656` 表示箭头向下、数值为正（即环比上升 2.87 个指数点）。
3. 采购价格指数**无阈值配置**（`threshold: null`），判断采购成本是否合理需结合父指标售价价格指数和定价毛利率综合判断。
4. 该指标当前**仅覆盖蔬菜品类**，其余 6 个大分类（水产、肉禽蛋、冷藏加工、水果、预制菜、猪肉）均返回 0。
5. 区域维度仅粤东、粤西有有效数据，华东和运营直管无有效数据（0 或 null）。
6. 趋势数据不连续，2026/05/02 至 2026/05/20 共 19 天返回 `current: 0`，仅月初和月末有有效数据，可能是数据采集周期或竞品对标数据可用性导致。
7. 同比值显示 92.19（等于当前值），说明去年同期无对标基数（基期为 0），该指标为新上线指标或去年同期未采集竞品数据。
8. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。