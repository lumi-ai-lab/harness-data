# 全链路毛利率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取全链路毛利率（`fullLinkStoreProfitNotaxRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code fullLinkStoreProfitNotaxRate --full
```

返回字段：`indicatorsName`（全链路到店毛利率（不含税））、`businessDefinition`（全链路到店毛利额（不含税）占销售额的比例，反映整体经营效率）、`statisticalLogic`（(供应链到店毛利额（不含税）+ 门店毛利额) / 销售额）、`indicatorBiz`（全链路）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator fullLinkStoreProfitNotaxRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "fullLinkStoreProfitNotaxRate",
  "indicatorName": "全链路到店毛利率（不含税）",
  "value": 0.29338,
  "valueUnit": 3,
  "mom": {
    "value": 0.0206,
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.0271,
    "status": "up",
    "unit": 3
  },
  "threshold": {
    "compareSymbol": "GT",
    "compareValue1": 27.9,
    "compareValue2": 27.9
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 `0.29338` 表示 29.34%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化
- `unit: 3` — 小数形式的比率变化（百分点变化），如 `mom.value: 0.0206` 表示环比上升 2.06 个百分点；`yoy.value: -0.0271` 表示同比下降 2.71 个百分点

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator fullLinkStoreProfitNotaxRate
```

返回最近约 30 天的逐日全链路毛利率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 0.29338,
      "compare": 0.28783
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator fullLinkStoreProfitNotaxRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的全链路毛利率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.31179,
      "yoy": { "value": -0.0145, "unit": 3 },
      "mom": { "value": 0.0187, "unit": 3 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.31152,
      "yoy": { "value": -0.0135, "unit": 3 },
      "mom": { "value": 0.0250, "unit": 3 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.27561,
      "yoy": { "value": 0.0022, "unit": 3 },
      "mom": { "value": 0.0053, "unit": 3 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0.26929,
      "yoy": { "value": -0.0287, "unit": 3 },
      "mom": { "value": 0.0135, "unit": 3 }
    }
  ]
}
```

区域排名按当前值降序排列。value 均为小数比率（valueUnit: 3），需 ×100 转为百分比。如 `current: 0.31179` 表示粤东全链路毛利率为 31.18%。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator fullLinkStoreProfitNotaxRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类全链路毛利率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.39387,
      "yoy": { "value": -0.0162, "unit": 3 },
      "mom": { "value": 0.0063, "unit": 3 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.32927,
      "yoy": { "value": -0.0319, "unit": 3 },
      "mom": { "value": 0.0101, "unit": 3 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.28704,
      "yoy": { "value": -0.0445, "unit": 3 },
      "mom": { "value": -0.0173, "unit": 3 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.28571,
      "yoy": { "value": -0.0260, "unit": 3 },
      "mom": { "value": 0.0032, "unit": 3 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0.25616,
      "yoy": { "value": -0.0405, "unit": 3 },
      "mom": { "value": 0.0089, "unit": 3 }
    }
  ]
}
```

品类排名按当前值降序排列，按**大分类**分组。value 均为小数比率（valueUnit: 3），需 ×100 转为百分比。如 `current: 0.39387` 表示猪肉全链路毛利率为 39.39%。

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
  - `管理区域` → `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` → `groupManagerId`
  - `大区` → `manageRegionId`
  - `门店` → `storeId`

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 水果` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` → `categoryLevel1Id`（如 12 水果、13 猪肉、10 蔬菜、11 水产）
  - `中分类` → `categoryLevel2Id`
  - `小分类` → `categoryLevel3Id`
  - `商品` → `articleId`
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
  --indicator fullLinkStoreProfitNotaxRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 水果品类 + 全量数据

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator fullLinkStoreProfitNotaxRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator fullLinkStoreProfitNotaxRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator fullLinkStoreProfitNotaxRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 品类表现（在水果范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator fullLinkStoreProfitNotaxRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator fullLinkStoreProfitNotaxRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator fullLinkStoreProfitNotaxRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 3** 表示小数形式的比率，需要 ×100 转为百分比。例如 `value: 0.29338` 表示全链路毛利率为 29.34%。
2. **同比/环比 unit: 3** 表示百分点变化（小数形式）。如 `mom.value: 0.0206` 表示环比上升 2.06 个百分点；`yoy.value: -0.0271` 表示同比下降 2.71 个百分点。
3. **阈值**：阈值目标为 >27.9%（`compareSymbol: "GT"`），当前值 29.34% 已超过阈值。
4. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。