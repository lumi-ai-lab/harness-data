# 全链路毛利额指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取全链路毛利额（`fullLinkStoreProfitAmtNotax`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code fullLinkStoreProfitAmtNotax --full
```

返回字段：`indicatorsName`（全链路到店毛利额（不含税））、`businessDefinition`（从商品采购入库到门店销售全流程产生的税前毛利）、`statisticalLogic`（供应链到店毛利额（不含税）+门店毛利额）、`indicatorBiz`（全链路）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator fullLinkStoreProfitAmtNotax --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "fullLinkStoreProfitAmtNotax",
  "indicatorName": "全链路到店毛利额（不含税）",
  "value": 5667.04,              // 当前值（金额）
  "valueUnit": 2,                // 单位类型（2=金额/比率直接使用）
  "mom": {
    "value": 0.0183,             // 环比变动（+1.83%）
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.2286,             // 同比变动（+22.86%）
    "status": "up",
    "unit": 2
  },
  "threshold": null              // 无阈值配置
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 5667.04 表示全链路毛利额为 5667.04）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量（如 `+0.25` 分）
- `unit: 2` — 比率变化（如 `0.0183` 表示 +1.83%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator fullLinkStoreProfitAmtNotax
```

返回最近约 30 天的逐日全链路毛利额数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/04/25",
      "current": 4688.25,
      "compare": 3708.99
    },
    {
      "period": "2026/04/26",
      "current": 4557.50,
      "compare": 4518.99
    },
    {
      "period": "2026/05/24",
      "current": 5667.04,
      "compare": 4626.22
    }
  ]
}
```

> 趋势数据共返回最近约 30 天的逐日数据（`2026/04/25` ~ `2026/05/24`），current 范围约 3191.64 ~ 5667.04，compare 范围约 2888.51 ~ 4626.22，整体呈上行态势。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator fullLinkStoreProfitAmtNotax
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的全链路毛利额排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 5012.45,
      "yoy": { "value": -0.0441 },
      "mom": { "value": 0.0141 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 4586.52,
      "yoy": { "value": 0.1910 },
      "mom": { "value": -0.0895 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 4125.26,
      "yoy": { "value": -0.0202 },
      "mom": { "value": 0.0157 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 3844.13,
      "yoy": { "value": -0.0485 },
      "mom": { "value": 0.0411 }
    }
  ]
}
```

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator fullLinkStoreProfitAmtNotax
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类全链路毛利额排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "13",
      "name": "猪肉",
      "current": 1664.03,
      "yoy": { "value": 0.2452 },
      "mom": { "value": -0.0060 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 1316.44,
      "yoy": { "value": 0.3401 },
      "mom": { "value": 0.0165 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 783.11,
      "yoy": { "value": 0.1678 },
      "mom": { "value": 0.1381 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 665.25,
      "yoy": { "value": 0.2059 },
      "mom": { "value": 0.2290 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 556.00,
      "yoy": { "value": 0.1749 },
      "mom": { "value": -0.0017 }
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
- 品类过滤与下钻：当指定大分类后，`area` 和 `category` 子命令会在此品类范围内进一步下钻。例如 `--category-type 大分类 --category 12` 时，`category` 子命令会显示该大分类下各中分类的全链路毛利额表现。

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
  --indicator fullLinkStoreProfitAmtNotax \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 水果品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator fullLinkStoreProfitAmtNotax \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator fullLinkStoreProfitAmtNotax \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator fullLinkStoreProfitAmtNotax \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 品类表现（在水果范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator fullLinkStoreProfitAmtNotax \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator fullLinkStoreProfitAmtNotax \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator fullLinkStoreProfitAmtNotax \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: 0.0183` 表示箭头向上、环比增长 1.83%。
3. 全链路毛利额 `threshold` 为 null，无预设阈值。
4. 全链路毛利额 `valueUnit: 2`，值为金额直接使用（如 5667.04），同比环比 unit 为 2（比率变化）。
5. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
6. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
7. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
8. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。