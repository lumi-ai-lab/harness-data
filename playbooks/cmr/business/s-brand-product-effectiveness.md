# 品效指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取品效（`brandProductEffectiveness`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code brandProductEffectiveness --full
```

返回字段：`indicatorsName`（品效）、`businessDefinition`（平均每个动销商品的销售额贡献）、`statisticalLogic`（店日均销售额 / 店日均销售sku数）、`indicatorBiz`（采购环节）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator brandProductEffectiveness --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "brandProductEffectiveness",
  "indicatorName": "品效",
  "value": 65.69,           // 当前值
  "valueUnit": 2,           // 单位类型（2=百分比/比率类）
  "mom": {
    "value": -0.039,        // 环比变动（-3.9%）
    "status": "up",         // 箭头方向
    "unit": 2
  },
  "yoy": {
    "value": 0.3356,        // 同比变动（+33.56%）
    "status": "up",
    "unit": 2
  },
  "threshold": {            // 阈值配置
    "compareSymbol": "GE",
    "compareValue1": 42,
    "compareValue2": 42
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 65.69 表示品效值为 65.69）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.2646 表示 26.46%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量（如 `+0.25` 分）
- `unit: 2` — 比率变化（如 `-0.039` 表示 -3.9%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator brandProductEffectiveness
```

返回最近约 30 天的逐日品效数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 65.6893984934385,   // 当前周期值
      "compare": 50.67404355113139   // 同比对照值（去年同期）
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator brandProductEffectiveness
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的品效排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 64.9986500678248,
      "yoy": { "value": -0.0382 },
      "mom": { "value": 0.0550 }
    }
  ]
}
```

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator brandProductEffectiveness
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类品效排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "12",
      "name": "水果",
      "current": 205.5041415652853,
      "yoy": { "value": 0.2630 },
      "mom": { "value": -0.1778 }
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
  - `管理区域` → `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` → `groupManagerId`（如 Q027115 等督导编码）
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
  - `中分类` → `categoryLevel2Id`（如 1124 两栖类）
  - `小分类` → `categoryLevel3Id`
  - `商品` → `articleId`
- 品类过滤与下钻：当指定大分类后，`area` 和 `category` 子命令会在此品类范围内进一步下钻。例如 `--category-type 大分类 --category 12` 时，`category` 子命令会显示该大分类下各中分类的品效表现。

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
  --indicator brandProductEffectiveness \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 水果品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator brandProductEffectiveness \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator brandProductEffectiveness \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator brandProductEffectiveness \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 品类表现（在水果范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator brandProductEffectiveness \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator brandProductEffectiveness \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator brandProductEffectiveness \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.039` 表示箭头向上但数值为 -3.9%（即环比下降）。
3. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
4. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
5. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
6. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。