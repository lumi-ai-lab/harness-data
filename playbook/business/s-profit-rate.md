# 门店毛利率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取门店毛利率（`profitRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code profitRate --full
```

返回字段：`indicatorsName`（门店毛利率）、`businessDefinition`（销售收入减去销售成本后，占销售收入的比例）、`statisticalLogic`（门店毛利额 / 销售额）、`indicatorBiz`（销售经营）。

**真实返回示例（2026-05-24）**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "销售收入减去销售成本后，占销售收入的比例",
    "indicatorBiz": "销售经营",
    "indicatorsCodeEn": "profitRate",
    "indicatorsName": "门店毛利率",
    "id": "1876889968834179074",
    "statisticalLogic": "门店毛利额/销售额"
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator profitRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "profitRate",
  "indicatorName": "门店毛利率",
  "value": 0.2130069965994926,
  "valueUnit": 3,
  "mom": {
    "value": 0.0204,
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.0221,
    "status": "up",
    "unit": 3
  },
  "threshold": {
    "compareSymbol": "GE",
    "compareValue1": 20.054538907683266,
    "compareValue2": 20.054538907683266
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 `0.21301` 表示 21.30%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化
- `unit: 3` — 小数形式的比率变化（百分点变化），如 `mom.value: 0.0204` 表示环比上升 2.04 个百分点；`yoy.value: -0.0221` 表示同比下降 2.21 个百分点

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator profitRate
```

返回最近约 30 天的逐日门店毛利率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 0.2130069965994925,
      "compare": 0.20604938974426515
    },
    {
      "period": "2026/05/23",
      "current": 0.19263719211602817,
      "compare": 0.174428792660826
    },
    {
      "period": "2026/05/22",
      "current": 0.20757465498749356,
      "compare": 0.18692894689812303
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

### 趋势分析要点

- **近 30 天区间**（基于 CLI 2026-05-24 真实数据）：最低 0.1785（05/20，对应 17.85%），最高 0.2351（05/17，对应 23.51%）。
- **当前值趋势位置**：05/24 为 0.2130（21.30%），处于近 30 天的中上位置。
- **与去年同期对比**：30 天中 25 天当前值高于同期比较值（占比 83%），说明门店毛利率相较去年多数时间有所改善。
- value 均为小数比率（valueUnit: 3），需 ×100 转为百分比。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator profitRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的门店毛利率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "sort": { "field": "current", "order": "DESC" },
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.22426446633426314,
      "yoy": { "value": -0.012479915293537952 },
      "mom": { "value": 0.02369797902350504 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.220810848220997,
      "yoy": { "value": -0.01995707930214191 },
      "mom": { "value": 0.02568644733046413 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.20238169003237286,
      "yoy": { "value": -0.00042799555698844194 },
      "mom": { "value": -0.0025243150206628595 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0.17461441877546482,
      "yoy": { "value": -0.020856175338741317 },
      "mom": { "value": 0.01487558052937335 }
    }
  ]
}
```

区域排名中的 value 均为小数比率（valueUnit: 3），需 ×100 转为百分比。如 `current: 0.2243` 表示粤东门店毛利率为 22.43%。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator profitRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类门店毛利率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "sort": { "field": "current", "order": "DESC" },
  "rows": [
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.3344440632184661,
      "yoy": { "value": -0.007414860846213345 },
      "mom": { "value": 0.004820535595975339 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.21148228200241445,
      "yoy": { "value": -0.035585049616808556 },
      "mom": { "value": 0.012815736946712841 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.20138003905823626,
      "yoy": { "value": -0.024399470074965485 },
      "mom": { "value": 0.015072610486871002 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0.1679288008874373,
      "yoy": { "value": -0.02298839345910142 },
      "mom": { "value": 0.0073902687233679265 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 0.16718336634709255,
      "yoy": { "value": -0.009712409073927064 },
      "mom": { "value": 0.06788973280014307 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.1605013166264132,
      "yoy": { "value": -0.03314228121877469 },
      "mom": { "value": -0.005435092850215206 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 0.147066516021183,
      "yoy": { "value": -0.029024153494577265 },
      "mom": { "value": 0.010049875905105421 }
    }
  ]
}
```

品类排名中的 value 均为小数比率（valueUnit: 3），需 ×100 转为百分比。如 `current: 0.3344` 表示猪肉品类门店毛利率为 33.44%。

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
  - `管理区域` → `manageAreaId`（如 CN00 全国、CN15 华东、CN18 粤东、CN01 粤西、CN07 运营直管）
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
  - `大分类` → `categoryLevel1Id`（如 13 猪肉、10 蔬菜、26 冷藏加工、11 水产、12 水果、25 预制菜、24 肉禽蛋）
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
  --indicator profitRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 猪肉品类 + 全量数据

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator profitRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator profitRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator profitRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13

# 品类表现（在猪肉范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator profitRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator profitRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator profitRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`（48 个指标）、`area`（4 个区域）、`category`（7 个品类）、`trend`（30 天趋势）四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 3** 表示小数形式的比率，需要 ×100 转为百分比。例如 `value: 0.21301` 表示门店毛利率为 21.30%。
2. **同比/环比 unit: 3** 表示百分点变化（小数形式）。如 `mom.value: 0.0204` 表示环比上升 2.04 个百分点；`yoy.value: -0.0221` 表示同比下降 2.21 个百分点。
3. **阈值**：阈值目标为 >=20.05%（`compareSymbol: "GE"`），当前值 21.30% 已超过阈值。
4. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。