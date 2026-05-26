# 可订门店数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取可订门店数（`storeCanOrders`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code storeCanOrders --full
```

返回字段：`indicatorsName`（可订门店数）、`businessDefinition`（平均每个商品每天根据被设置为可订购的门店数）、`statisticalLogic`（统计期内，按商品-日统计：被设置为可订购的门店数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator storeCanOrders --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "storeCanOrders",
  "indicatorName": "可订门店数",
  "value": 506.7480093676815,
  "valueUnit": 2,
  "mom": {
    "value": -0.0032,
    "arrowStatus": "up",
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": -0.019,
    "arrowStatus": "up",
    "status": "up",
    "unit": 2
  },
  "threshold": null
}
```

**valueUnit = 2 的含义**：直接显示值（不额外转换）。`value: 506.75` 表示可订门店数为 506.75（店日均口径）。

**同比/环比 unit = 2 的含义**：比率变化。如 `mom.value: -0.0032` 表示环比下降 0.32%；`yoy.value: -0.019` 表示同比下降 1.90%。

**阈值配置**：无阈值（`threshold: null`），该指标无硬性达标要求。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 -0.0032 表示 -0.32%）
- `unit: 3` — 小数形式的比率变化（百分点变化）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator storeCanOrders
```

返回最近约 30 天的逐日可订门店数数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/04/25",
      "current": 526.2451495092445,
      "compare": 527.15675
    },
    {
      "period": "2026/05/01",
      "current": 521.2059838895282,
      "compare": 531.3440343781598
    },
    {
      "period": "2026/05/10",
      "current": 524.3569116967175,
      "compare": 532.4240282685512
    },
    {
      "period": "2026/05/17",
      "current": 516.5605846298915,
      "compare": 529.0296110414052
    },
    {
      "period": "2026/05/24",
      "current": 506.7480093676815,
      "compare": 527.8893882646692
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator storeCanOrders
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的可订门店数排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 969.5866050808314,
      "yoy": { "value": 0.0007565090329050516 },
      "mom": { "value": 0.0022387319060862896 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 818.7232346241458,
      "yoy": { "value": -0.0005221870773105678 },
      "mom": { "value": 0.0052974614255544596 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 183.88835534213686,
      "yoy": { "value": -0.07499990006670881 },
      "mom": { "value": -0.07717333784899341 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 5.3508571428571425,
      "yoy": { "value": 0.0007722936286388275 },
      "mom": { "value": 0.0015648125459446227 }
    }
  ]
}
```

区域排名：粤西（969.59）> 粤东（818.72）> 华东（183.89）> 运营直管（5.35）。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator storeCanOrders
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类可订门店数排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "10",
      "name": "蔬菜",
      "current": 748.9503407984421,
      "yoy": { "value": -0.02537216635010949 },
      "mom": { "value": 0.006909834548000926 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 557.670731707317,
      "yoy": { "value": -0.0007423032202675305 },
      "mom": { "value": -0.002088452233364067 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 516.7047244094488,
      "yoy": { "value": 0.008115629992650652 },
      "mom": { "value": 0.004227771231351273 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 504.83549783549785,
      "yoy": { "value": -0.04873657841436253 },
      "mom": { "value": -0.057965362777647675 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 497.75791433891993,
      "yoy": { "value": -0.0012801751252322744 },
      "mom": { "value": -0.008435518504061238 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 400.5656836461126,
      "yoy": { "value": 0.01882939965335614 },
      "mom": { "value": 0.00994064652545287 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 311.81993299832493,
      "yoy": { "value": -0.009277550206310934 },
      "mom": { "value": 0.0007945122002269186 }
    }
  ]
}
```

品类排名：蔬菜（748.95）> 水产（557.67）> 猪肉（516.70）> 预制菜（504.84）> 肉禽蛋（497.76）> 水果（400.57）> 冷藏加工（311.82）。

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
  - `管理区域` → `manageAreaId`（如 CN00 全国、CN01 粤西、CN18 粤东、CN15 华东、CN07 运营直管）
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
  - `大分类` → `categoryLevel1Id`（如 10 蔬菜、13 猪肉、11 水产、12 水果、24 肉禽蛋、25 预制菜、26 冷藏加工）
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
  --indicator storeCanOrders \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域 + 蔬菜品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator storeCanOrders \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator storeCanOrders \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10

# 区域表现（在粤西范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator storeCanOrders \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10

# 品类表现（在蔬菜范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator storeCanOrders \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator storeCanOrders \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator storeCanOrders \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 2**：表示直接显示值（店日均口径），如 `value: 506.75` 即为可订门店数 506.75。注意该值并非整数，原因是店日均口径下的平滑计算。
2. **同比/环比 unit: 2**：表示比率变化。如 `yoy.value: -0.019` 表示同比下降 1.90%；`mom.value: -0.0032` 表示环比下降 0.32%。
3. **无阈值**：该指标无阈值配置（`threshold: null`），不单独设置达标标准，其表现通过父指标商品订购渗透率间接评估。
4. 可订门店数是商品订购渗透率计算的分母（渗透率 = 订购门店数 / 可订门店数）。
5. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
6. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
7. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
8. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
9. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
10. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。