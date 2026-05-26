# 订购门店数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取订购门店数（`orderStores`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code orderStores --full
```

返回字段：`indicatorsName`（订购门店数）、`businessDefinition`（提交订购且订购数量大于0的门店数）、`indicatorBiz`（销售经营）、`statisticalLogic`（提交订购且订购数量大于0的门店数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator orderStores --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "orderStores",
  "indicatorName": "订购门店数",
  "value": 173.87611241217797,
  "valueUnit": 2,
  "mom": {
    "value": -0.0122,
    "arrowStatus": "up",
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.0031,
    "arrowStatus": "up",
    "status": "up",
    "unit": 2
  },
  "threshold": null
}
```

**valueUnit = 2 的含义**：直接显示值（不额外转换）。`value: 173.88` 表示订购门店数为 173.88（店日均口径）。

**同比/环比 unit = 2 的含义**：比率变化。如 `mom.value: -0.0122` 表示环比下降 1.22%；`yoy.value: 0.0031` 表示同比上升 0.31%。

**阈值配置**：无阈值（`threshold: null`），该指标无硬性达标要求。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 -0.0122 表示 -1.22%）
- `unit: 3` — 小数形式的比率变化（如 -0.0025 表示 -0.25 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator orderStores
```

返回最近约 30 天的逐日订购门店数数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/04/25",
      "current": 168.66811230312715,
      "compare": 188.48225
    },
    {
      "period": "2026/05/01",
      "current": 166.10264672036823,
      "compare": 188.345298281092
    },
    {
      "period": "2026/05/10",
      "current": 169.98543689320388,
      "compare": 194.36496718828874
    },
    {
      "period": "2026/05/17",
      "current": 173.34229137199435,
      "compare": 195.62735257214555
    },
    {
      "period": "2026/05/24",
      "current": 173.87611241217797,
      "compare": 192.929088639201
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator orderStores
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的订购门店数排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 334.32909930715937,
      "yoy": { "value": 0.017829162185401135 },
      "mom": { "value": -0.005048231620601088 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 281.9635535307517,
      "yoy": { "value": 0.04284732455147192 },
      "mom": { "value": -0.004073530078182946 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 52.696278511404564,
      "yoy": { "value": -0.06604768704301547 },
      "mom": { "value": -0.08545691623235244 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 2.273142857142857,
      "yoy": { "value": 0.21541278610891873 },
      "mom": { "value": 0.007336910804931115 }
    }
  ]
}
```

区域排名：粤西（334.33）> 粤东（281.96）> 华东（52.70）> 运营直管（2.27）。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator orderStores
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类订购门店数排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "10",
      "name": "蔬菜",
      "current": 327.50925024342746,
      "yoy": { "value": 0.025316109558070784 },
      "mom": { "value": -0.004472111921492482 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 142.57705192629817,
      "yoy": { "value": -0.0033213714100357346 },
      "mom": { "value": -0.004675913938974658 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 138.15367965367966,
      "yoy": { "value": -0.03527028967435256 },
      "mom": { "value": -0.06452858628662321 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 128.53658536585365,
      "yoy": { "value": 0.0003041721889815087 },
      "mom": { "value": -0.01987090877934539 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 127.90316573556797,
      "yoy": { "value": 0.004271776771551402 },
      "mom": { "value": -0.017876186491315848 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 88.6916890080429,
      "yoy": { "value": 0.0032996494122499343 },
      "mom": { "value": 0.0027112750221590684 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 69.11811023622047,
      "yoy": { "value": 0.0616261962556451 },
      "mom": { "value": -0.0009002828503928788 }
    }
  ]
}
```

品类排名：蔬菜（327.51）> 冷藏加工（142.58）> 预制菜（138.15）> 水产（128.54）> 肉禽蛋（127.90）> 水果（88.69）> 猪肉（69.12）。

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
  --indicator orderStores \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域 + 蔬菜品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator orderStores \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator orderStores \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10

# 区域表现（在粤西范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator orderStores \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10

# 品类表现（在蔬菜范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator orderStores \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator orderStores \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator orderStores \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 2**：表示直接显示值（店日均口径），如 `value: 173.88` 即为订购门店数 173.88。注意该值并非整数，原因是店日均口径下的平滑计算。
2. **同比/环比 unit: 2**：表示比率变化。如 `yoy.value: 0.0031` 表示同比上升 0.31%；`mom.value: -0.0122` 表示环比下降 1.22%。
3. **无阈值**：该指标无阈值配置（`threshold: null`），不单独设置达标标准，其表现通过父指标商品订购渗透率间接评估。
4. 订购门店数是商品订购渗透率计算的分子（渗透率 = 订购门店数 / 可订门店数）。
5. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
6. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
7. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
8. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
9. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
10. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。