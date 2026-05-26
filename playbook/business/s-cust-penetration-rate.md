# 客数渗透率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取客数渗透率（`custPenetrationRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code custPenetrationRate --full
```

返回字段：`indicatorsName`（客流渗透率，报告中使用"客数渗透率"）、`businessDefinition`（到店的客流占门店300米半径范围覆盖的小区户数的占比）、`statisticalLogic`（来客数 / 门店覆盖户数；若门店复购户数为空则显示"--"）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator custPenetrationRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "custPenetrationRate",
  "indicatorName": "客数渗透率",
  "value": 0.2645891472717553,
  "valueUnit": 3,
  "mom": {
    "value": 0.0007,
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.0011,
    "status": "up",
    "unit": 3
  },
  "threshold": {
    "compareSymbol": "GE",
    "compareValue1": 30,
    "compareValue2": 30,
    "compareValueType": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数 595）
- `valueUnit: 2` — 百分比/比率/金额（如销售额 19316.37）
- `valueUnit: 3` — 小数形式的比率（需乘100转为百分比，如 0.2646 表示 26.46%）

**同比/环比的 unit（仅对 custPenetrationRate 自身的 mom/yoy）**：
- `unit: 1` — 绝对变化量（如三率综合得分 mom: +0.25）
- `unit: 2` — 比率变化（如销售额 mom: -0.0533 表示 -5.33%）
- `unit: 3` — 小数形式的比率变化（如客数渗透率 mom: 0.0007 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator custPenetrationRate
```

返回最近 30 天的逐日客数渗透率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    { "period": "2026/05/24", "current": 0.2645891472717553, "compare": 0.27813936719691545 },
    { "period": "2026/05/23", "current": 0.2638417567628681, "compare": 0.2364363342450683 },
    { "period": "2026/05/22", "current": 0.2450145289707736, "compare": 0.24490872846577882 },
    { "period": "2026/05/21", "current": 0.24061615803202355, "compare": 0.2446406192282653 },
    { "period": "2026/05/20", "current": 0.23179549340459768, "compare": 0.24226987070863554 },
    { "period": "2026/05/19", "current": 0.24226955536218853, "compare": 0.24124586533636982 },
    { "period": "2026/05/18", "current": 0.24127430275924613, "compare": 0.27046888970430955 },
    { "period": "2026/05/17", "current": 0.2657376453911243, "compare": 0.27298952223852246 },
    { "period": "2026/05/16", "current": 0.2663620943085892, "compare": 0.24078424434990253 },
    { "period": "2026/05/15", "current": 0.23859215462153543, "compare": 0.24609932847009397 }
  ]
}
```

- 近 30 天范围：2026/04/25 - 2026/05/24。
- 波动区间：约 0.1964（5/3 最低）~ 0.2729（4/25 最高），整体在 0.23-0.27 之间波动。
- 可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator custPenetrationRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的客数渗透率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01", "name": "粤西",
      "current": 0.2690413830864138,
      "yoy": { "value": 0.003460782018234909 },
      "mom": { "value": 0.0020751297728351936 }
    },
    {
      "code": "CN18", "name": "粤东",
      "current": 0.26789606416897904,
      "yoy": { "value": -0.002722207901381446 },
      "mom": { "value": 0.00442111909903653 }
    },
    {
      "code": "CN07", "name": "运营直管",
      "current": 0.2093523563098408,
      "yoy": { "value": 0.045539296783279726 },
      "mom": { "value": -0.0068331875334427805 }
    },
    {
      "code": "CN15", "name": "华东",
      "current": 0.18465881345328117,
      "yoy": { "value": -0.019980296526117602 },
      "mom": { "value": -0.010142610855224832 }
    }
  ]
}
```

- **领先区域**：粤西（26.90%）、粤东（26.79%），接近全国均值（26.46%），小幅高于全国。
- **拖累区域**：运营直管（20.94%）、华东（18.47%），显著低于全国均值。
- 运营直管同比大幅改善（+4.55 个百分点），华东同环比双降。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator custPenetrationRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类客数渗透率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "10", "name": "蔬菜",
      "current": 0.19265977384600055,
      "yoy": { "value": 0.00026733506019885334 },
      "mom": { "value": 0.0011793036933541723 }
    },
    {
      "code": "13", "name": "猪肉",
      "current": 0.06715957909826813,
      "yoy": { "value": -0.0010974595701832707 },
      "mom": { "value": -0.0012556595315644098 }
    },
    {
      "code": "26", "name": "冷藏加工",
      "current": 0.05771237829023966,
      "yoy": { "value": 0.0012147489410950923 },
      "mom": { "value": -0.0010905841873909833 }
    },
    {
      "code": "12", "name": "水果",
      "current": 0.048372510422044115,
      "yoy": { "value": -0.0003709086033061096 },
      "mom": { "value": 0.001499128681160096 }
    },
    {
      "code": "24", "name": "肉禽蛋",
      "current": 0.03510412109148279,
      "yoy": { "value": 0.0015285390028419513 },
      "mom": { "value": 0.001239491658349072 }
    }
  ]
}
```

- **领先品类**：蔬菜（19.27%），遥遥领先其他品类，是客数渗透率的绝对主力品类。
- **次级品类**：猪肉（6.72%）、冷藏加工（5.77%）、水果（4.84%）。
- 品类间渗透率差距悬殊（蔬菜 > 肉禽蛋 5.5 倍），品类结构分化明显。

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
  - `督导` -> `groupManagerId`（如 Q027115 等督导编码）
  - `大区` -> `manageRegionId`
  - `门店` -> `storeId`

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 水果` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` -> `categoryLevel1Id`（如 12 水果、13 猪肉、10 蔬菜、11 水产）
  - `中分类` -> `categoryLevel2Id`（如 1124 两栖类）
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
  --indicator custPenetrationRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 水果品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator custPenetrationRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator custPenetrationRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator custPenetrationRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 品类表现（在水果范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator custPenetrationRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator custPenetrationRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator custPenetrationRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）仅表示箭头方向，不代表数值正负。如 `status: "up"` 且 `value: -0.0011` 表示箭头向上但数值为 -0.11 个百分点。
3. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
4. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
5. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
6. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。