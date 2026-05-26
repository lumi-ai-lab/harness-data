# 集采入库占比取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取集采入库占比（`centralInstockRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code centralInstockRate --full
```

返回字段：`indicatorsName`（集采入库占比）、`businessDefinition`（集采入库金额占整体入库金额的占比）、`statisticalLogic`（（集采仓的调拨出库金额（不含税）- 集采仓的调拨退货入库金额（不含税）） / （集采仓的调拨出库金额（不含税）- 集采仓的调拨退货入库金额（不含税）+ 非集采仓的采购入库额（不含税）- 非集采仓的采购退货额（不含税）））、`indicatorBiz`（入库环节）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator centralInstockRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "centralInstockRate",
  "indicatorName": "集采入库占比",
  "value": 0.1477817545602856,
  "valueUnit": 3,
  "mom": {
    "value": -0.0023,
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.0307,
    "status": "up",
    "unit": 3
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 65.69 表示品效值为 65.69）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1478 表示 14.78%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量（如 `+0.25` 分）
- `unit: 2` — 比率变化（如 `-0.039` 表示 -3.9%）
- `unit: 3` — 小数形式的比率变化（如 `-0.0023` 表示 -0.23 个百分点）

### 返回的 indicators 列表说明

`report business indicators` 返回的是经营分析全量指标列表（约 38 个指标），集采入库占比是其中之一。需要从 `items` 数组中筛选 `indicatorCode: "centralInstockRate"` 的条目。集采入库占比当前**无阈值配置**（`threshold: null`）。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator centralInstockRate
```

返回最近约 30 天的逐日集采入库占比数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 0.1477817545602856,
      "compare": 0.1974529147914517
    }
  ]
}
```

- `current`：当前周期值（`valueUnit: 3`，需 ×100 转为百分比，如 0.1478 表示 14.78%）。
- `compare`：同比对照值（去年同期）。
- 实际返回数据显示，集采入库占比在最近 7 天（05/18-05/24）出现明显下行，从约 18% 降至约 14.3%-15.0% 区间。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator centralInstockRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的集采入库占比排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.18598992933422542,
      "yoy": { "value": -0.0008306499506275378, "unit": 3 },
      "mom": { "value": -0.0015813664792747317, "unit": 3 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.16253851701736846,
      "yoy": { "value": -0.04390417536132238, "unit": 3 },
      "mom": { "value": -0.007756554380453418, "unit": 3 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.15741858232881648,
      "yoy": { "value": -0.006199796291015608, "unit": 3 },
      "mom": { "value": -0.025099414072688925, "unit": 3 }
    }
  ]
}
```

- `current`：`valueUnit: 3`，需 ×100 转为百分比。如 0.1860 表示粤西集采入库占比为 18.60%。
- 排序规则：按 `current` 降序排列（`sort: { field: "current", order: "DESC" }`）。
- 实际返回 4 个区域：粤西（18.60%）> 华东（16.25%）> 粤东（15.74%）> 运营直管（0%）。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator centralInstockRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类集采入库占比排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.3049993970536289,
      "yoy": { "value": -0.06150782085347162, "unit": 3 },
      "mom": { "value": 0.04498948348005194, "unit": 3 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0.30317185741039393,
      "yoy": { "value": -0.10761725642074849, "unit": 3 },
      "mom": { "value": -0.1108114406810507, "unit": 3 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 0.3002562718410453,
      "yoy": { "value": -0.0712203951296933, "unit": 3 },
      "mom": { "value": 0.03497798297696908, "unit": 3 }
    }
  ]
}
```

- `current`：`valueUnit: 3`，需 ×100 转为百分比。如 0.3050 表示蔬菜的集采入库占比为 30.50%。
- 排序规则：按 `current` 降序排列。
- 实际返回 7 个大分类：蔬菜（30.50%）、水产（30.32%）、水果（30.03%）三个品类有集采入库数据，预制菜、猪肉、肉禽蛋、冷藏加工均为 0。

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
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 粤西` | 具体区域 |

- `--area-type` 和 `--area` 必须**成对使用**，不能只传一个。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。
- 常见 `--area-type` 映射：
  - `管理区域` → `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` → `groupManagerId`（如 Q027115 等督导编码）
  - `大区` → `manageRegionId`
  - `门店` → `storeId`

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 10` / `--category 蔬菜` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` → `categoryLevel1Id`（如 10 蔬菜、11 水产、12 水果、13 猪肉）
  - `中分类` → `categoryLevel2Id`
  - `小分类` → `categoryLevel3Id`
  - `商品` → `articleId`
- 品类过滤与下钻：当指定大分类后，`area` 和 `category` 子命令会在此品类范围内进一步下钻。例如 `--category-type 大分类 --category 10` 时，`category` 子命令会显示蔬菜大分类下各中分类的集采入库占比表现。

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
  --indicator centralInstockRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域 + 蔬菜品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator centralInstockRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator centralInstockRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10

# 区域表现（在粤西范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator centralInstockRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10

# 品类表现（在蔬菜范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator centralInstockRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10
```

### 示例 3：月度汇总 + 华东区域

```bash
qdm-cmr-cli report business indicators \
  --indicator centralInstockRate \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator centralInstockRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.0023` 表示箭头向上但数值为 -0.0023（即环比下降 0.23 个百分点）。
3. 集采入库占比的 `valueUnit` 为 3（小数形式的比率），因此当前值、同比变动、环比变动均需 ×100 后解读为百分比或百分点。例如 `value: 0.1478` 表示 14.78%，`yoy.value: -0.0307` 表示同比下降 3.07 个百分点。
4. 集采入库占比**无阈值配置**（`threshold: null`），因此在报告模板中不出现阈值对比行。
5. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
6. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
7. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
8. 集采入库占比仅蔬菜、水产、水果三个大分类有值，猪肉、肉禽蛋、预制菜、冷藏加工均为 0，说明这些品类目前无集采入库。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。