# 准点率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取准点率（`vendorIntimeRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code vendorIntimeRate --full
```

返回字段：`indicatorsName`（供应商准点率）、`businessDefinition`（供应商按时送货到仓库的次数占总送货次数的比例）、`statisticalLogic`（供应商准点次数/供应商送货次数）、`indicatorBiz`（采购环节）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator vendorIntimeRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构（准点率相关）

```json
{
  "indicatorCode": "vendorIntimeRate",
  "indicatorName": "准点率",
  "value": 0.9188598772495579,
  "valueUnit": 3,
  "mom": {
    "arrowStatus": "up",
    "status": "up",
    "unit": 3,
    "value": 0.0047
  },
  "yoy": {
    "arrowStatus": "up",
    "status": "up",
    "unit": 3,
    "value": -0.0403
  },
  "threshold": {
    "compareSymbol": "GE",
    "compareValue1": 99,
    "compareValue2": 99,
    "compareValueType": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 65.69 表示品效值为 65.69）
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比，如 0.9189 表示 91.89%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化
- `unit: 3` — 小数形式的比率变化（如 -0.0403 表示 -4.03 个百分点，+0.0047 表示 +0.47 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator vendorIntimeRate
```

返回最近约 30 天的逐日准点率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 0.9188598772495579,
      "compare": 0.9638018628281118
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator vendorIntimeRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的准点率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.9825378346915018,
      "yoy": { "value": -0.01041991178737145 },
      "mom": { "value": -0.01063622674194531 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.9345132743362832,
      "yoy": { "value": -0.02685698805438741 },
      "mom": { "value": 0.00512987784988983 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.9224305106658048,
      "yoy": { "value": -0.014715938108550874 },
      "mom": { "value": 0.02337094953727814 }
    }
  ]
}
```

> 注：运营直管（CN07）返回值为 0，属于无效数据（该区域无供应商送货场景）。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator vendorIntimeRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类准点率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "11",
      "name": "水产",
      "current": 0.9920508744038156,
      "yoy": { "value": 0.004629490756016819 },
      "mom": { "value": 0.011989524710564026 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.9765395894428153,
      "yoy": { "value": -0.01814126162101448 },
      "mom": { "value": 0.013358440694656193 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.9395799676898223,
      "yoy": { "value": -0.0278776594288217 },
      "mom": { "value": -0.006994513768380117 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.9100678733031674,
      "yoy": { "value": -0.07296084732346442 },
      "mom": { "value": -0.013773186299481655 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 0.8998302207130731,
      "yoy": { "value": 0.0041780468000295334 },
      "mom": { "value": 0.009011362152279045 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.8560490045941807,
      "yoy": { "value": -0.08058465877215604 },
      "mom": { "value": 0.045971485214335694 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 0.8489208633093526,
      "yoy": { "value": -0.1287861430600742 },
      "mom": { "value": 0.012738527127016397 }
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
  - `管理区域` -> `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` -> `groupManagerId`
  - `大区` -> `manageRegionId`
  - `门店` -> `storeId`

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 水产` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` -> `categoryLevel1Id`（如 11 水产、25 预制菜、10 蔬菜、12 水果）
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
  --indicator vendorIntimeRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 水产品类

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator vendorIntimeRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 11 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator vendorIntimeRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 11

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator vendorIntimeRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 11

# 品类表现（在水产范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator vendorIntimeRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 11
```

### 示例 3：月度汇总 + 粤西区域

```bash
qdm-cmr-cli report business indicators \
  --indicator vendorIntimeRate \
  --month 2026-05 \
  --area-type 管理区域 --area CN01 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator vendorIntimeRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.0403` 表示箭头向上但数值为 -4.03 个百分点（即同比下降）。
3. 准点率的 `valueUnit` 为 3，需 x100 转为百分比阅读。同比环比的 `unit` 为 3，表示百分点变化。
4. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
5. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
6. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
7. 运营直管（CN07）区域的准点率值为 0，属于无效数据（该区域无供应商送货场景），应在分析中排除。
8. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。