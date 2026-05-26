# 商品订购渗透率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取商品订购渗透率（`orderArticleRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code orderArticleRate --full
```

返回字段：`indicatorsName`（商品订购渗透率）、`businessDefinition`（每个商品的门店订购占比情况，衡量商品的门店覆盖程度）、`statisticalLogic`（每个商品的门店订购占比情况，衡量商品的门店覆盖程度）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator orderArticleRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "orderArticleRate",
  "indicatorName": "商品订购渗透率",
  "value": 0.2691327034074733,
  "valueUnit": 3,
  "mom": {
    "value": -0.0025,
    "arrowStatus": "up",
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": 0.0045,
    "arrowStatus": "up",
    "status": "up",
    "unit": 3
  },
  "threshold": {
    "compareSymbol": "GE",
    "compareValue1": 80,
    "compareValue2": 80,
    "compareValueType": 2
  }
}
```

**valueUnit = 3 的含义**：小数形式的比率，需 x100 转为百分比。如 `value: 0.2691327034074733` 表示渗透率为 26.91%。

**同比/环比 unit = 3 的含义**：小数形式的比率变化（百分点变化）。如 `mom.value: -0.0025` 表示环比下降 0.25 个百分点；`yoy.value: 0.0045` 表示同比上升 0.45 个百分点。

**阈值配置**：`compareSymbol: "GE"`（大于等于），`compareValue1: 80`，`compareValueType: 2`（百分比值），即渗透率阈值目标 >=80%。当前值 26.91% 远未达到阈值，差距约 53pp。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` -- 整数值（如客数、门店数）
- `valueUnit: 2` -- 百分比/比率/金额（直接用值）
- `valueUnit: 3` -- 小数形式的比率（需 x100 转为百分比）

**同比/环比的 value**：
- `unit: 1` -- 绝对变化量
- `unit: 2` -- 比率变化（如 -0.039 表示 -3.9%）
- `unit: 3` -- 小数形式的比率变化（如 -0.0025 表示 -0.25 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator orderArticleRate
```

返回最近约 30 天的逐日商品订购渗透率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/04/25",
      "current": 0.2560928058176781,
      "compare": 0.2918877768592115
    },
    {
      "period": "2026/05/01",
      "current": 0.2539461603901519,
      "compare": 0.2876035325017983
    },
    {
      "period": "2026/05/10",
      "current": 0.25794819372843436,
      "compare": 0.29370269903909274
    },
    {
      "period": "2026/05/17",
      "current": 0.26465164741455055,
      "compare": 0.29632042960195754
    },
    {
      "period": "2026/05/24",
      "current": 0.2691327034074733,
      "compare": 0.2903437753587148
    }
  ]
}
```

**趋势特征**：近30天当前值在 0.247（24.7%）到 0.272（27.2%）区间波动，整体呈缓慢上升趋势，近一周从 0.262 升至 0.269。同比对比：去年同期在 0.280-0.297（28.0%-29.7%）区间，当前年份整体低于去年同期。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator orderArticleRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的商品订购渗透率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0.3240559895833333,
      "yoy": { "value": 0.05789008494584147 },
      "mom": { "value": 0.0024118858482167216 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.28598922648072356,
      "yoy": { "value": 0.009586976572717454 },
      "mom": { "value": -0.0030437544780024806 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.26191530629029836,
      "yoy": { "value": 0.0047804189856275325 },
      "mom": { "value": -0.001240349779806027 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.2291979995524493,
      "yoy": { "value": -0.0032346889093320674 },
      "mom": { "value": -0.002340644330181302 }
    }
  ]
}
```

区域排名（由高到低）：运营直管（32.41%）> 粤东（28.60%）> 粤西（26.19%）> 华东（22.92%）。所有区域均远未达到 80% 阈值。运营直管同比改善最显著（+5.79pp），华东同环比均为负（yoy -0.32pp, mom -0.23pp）是唯一双降区域。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator orderArticleRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类商品订购渗透率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.4613706455931533,
      "yoy": { "value": 0.000509534941095513 },
      "mom": { "value": -0.0032113928768407463 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.4413599079362955,
      "yoy": { "value": 0.020985504903919594 },
      "mom": { "value": -0.005213455542637191 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.27526844624606495,
      "yoy": { "value": 0.0028964022778610876 },
      "mom": { "value": -0.0022435773356695443 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 0.2607464373891706,
      "yoy": { "value": 0.001768151529385753 },
      "mom": { "value": -0.0016656343149364927 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0.2326950749048792,
      "yoy": { "value": -0.00019293208987020138 },
      "mom": { "value": -0.0041275431450412126 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 0.2263748756572403,
      "yoy": { "value": -0.0028386383952562766 },
      "mom": { "value": 0.00004628602981082697 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.13492879504020625,
      "yoy": { "value": 0.006515898187248265 },
      "mom": { "value": -0.0008787872366243232 }
    }
  ]
}
```

品类排名（由高到低）：冷藏加工（46.14%）> 蔬菜（44.14%）> 预制菜（27.53%）> 肉禽蛋（26.07%）> 水产（23.27%）> 水果（22.64%）> 猪肉（13.49%）。蔬菜同比改善最显著（+2.10pp），是渗透率增长的主要品类贡献者。所有品类均远未达 80% 阈值。品类间分化显著，最高（冷藏加工 46.14%）与最低（猪肉 13.49%）差距达 32.65pp。

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
  - `管理区域` -> `manageAreaId`（如 CN00 全国、CN07 运营直管、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` -> `groupManagerId`
  - `大区` -> `manageRegionId`
  - `门店` -> `storeId`

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 蔬菜` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` -> `categoryLevel1Id`（如 10 蔬菜、13 猪肉、11 水产、12 水果、24 肉禽蛋、25 预制菜、26 冷藏加工）
  - `中分类` -> `categoryLevel2Id`
  - `小分类` -> `categoryLevel3Id`
  - `商品` -> `articleId`
- 品类过滤与下钻：当指定大分类后，`area` 和 `category` 子命令会在此品类范围内进一步下钻。例如 `--category-type 大分类 --category 10` 时，`category` 子命令会显示该大分类下各中分类的渗透率表现。

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
  --indicator orderArticleRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 运营直管区域 + 蔬菜品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator orderArticleRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN07 \
  --category-type 大分类 --category 10 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator orderArticleRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN07 \
  --category-type 大分类 --category 10

# 区域表现（在运营直管范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator orderArticleRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN07 \
  --category-type 大分类 --category 10

# 品类表现（在蔬菜范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator orderArticleRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN07 \
  --category-type 大分类 --category 10
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator orderArticleRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator orderArticleRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 3** 表示小数形式的比率，需要 x100 转为百分比。例如 `value: 0.2691` 表示 26.91%。
2. **同比/环比 unit: 3** 表示百分点变化（小数形式）。如 `yoy.value: 0.0045` 表示同比上升 0.45 个百分点；`mom.value: -0.0025` 表示环比下降 0.25 个百分点。
3. **阈值**：阈值目标为 >=80%（`compareSymbol: "GE"`，`compareValueType: 2`），当前值 26.91% 远未达标（差距约 53pp）。所有区域和品类均未达到阈值。
4. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.0025` 表示箭头向上但数值为负（即环比下降）。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。