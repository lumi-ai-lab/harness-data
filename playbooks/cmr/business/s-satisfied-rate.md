# 订单满足率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取订单满足率（`satisfiedRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code satisfiedRate --full
```

返回字段：`indicatorsName`（订单满足率）、`businessDefinition`（满足分拣标准的订单数占门店订购订单数的比例）、`statisticalLogic`（订单满足次数 / 订购订单次数）、`indicatorBiz`（仓储环节）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator satisfiedRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "satisfiedRate",
  "indicatorName": "订单满足率",
  "value": 0.99653,
  "valueUnit": 3,
  "mom": {
    "value": -0.0117,
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.0019,
    "status": "up",
    "unit": 3
  },
  "threshold": {
    "compareSymbol": "BETWEEN",
    "compareValue1": 99.5,
    "compareValue2": 100.5,
    "compareValueType": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 65.69 表示品效值为 65.69）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.99653 表示 99.65%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量（如 `+0.25` 分）
- `unit: 2` — 比率变化（如 `-0.039` 表示 -3.9%）
- `unit: 3` — 小数形式的比率变化（如 `-0.0117` 表示 -1.17 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator satisfiedRate
```

返回最近约 30 天的逐日订单满足率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/04/25",
      "current": 0.9981701640874784,
      "compare": 1.0148659729818763
    },
    {
      "period": "2026/04/26",
      "current": 1.0016919376620261,
      "compare": 0.9873359835843043
    },
    {
      "period": "2026/05/24",
      "current": 0.9965317105044067,
      "compare": 1.0088962497102847
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator satisfiedRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的订单满足率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 1.034460937796641,
      "yoy": { "value": 0.030791069853116637 },
      "mom": { "value": 0.008204199738801599 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.9979467994656325,
      "yoy": { "value": -0.01442911147991166 },
      "mom": { "value": -0.018099698873332293 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.99575902942655,
      "yoy": { "value": 0.0008607718961265443 },
      "mom": { "value": 0.027585378982457498 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.9923689679257467,
      "yoy": { "value": 0.0075485690037259134 },
      "mom": { "value": -0.02791639360970144 }
    }
  ]
}
```

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator satisfiedRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类订单满足率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "12",
      "name": "水果",
      "current": 1.0342922619736679,
      "yoy": { "value": -0.014573335096065732 },
      "mom": { "value": -0.03712842481183465 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 1.0284124463868674,
      "yoy": { "value": -0.0012634042478640861 },
      "mom": { "value": -0.00017774704102291317 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 1.0223401370358673,
      "yoy": { "value": 0.0029621917102466977 },
      "mom": { "value": -0.007378534061379227 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.987749701199328,
      "yoy": { "value": -0.014601079578410059 },
      "mom": { "value": -0.006198346725174053 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0.9864626728119255,
      "yoy": { "value": 0.007440909397927076 },
      "mom": { "value": -0.02006339465237117 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.9623779712892633,
      "yoy": { "value": 0.01600022206712637 },
      "mom": { "value": -0.006147765981696751 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.9545225942335408,
      "yoy": { "value": -0.016575034508076736 },
      "mom": { "value": 0.00277487488300876 }
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
- 品类过滤与下钻：当指定大分类后，`area` 和 `category` 子命令会在此品类范围内进一步下钻。例如 `--category-type 大分类 --category 12` 时，`category` 子命令会显示该大分类下各中分类的订单满足率表现。

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
  --indicator satisfiedRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 水果品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator satisfiedRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator satisfiedRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator satisfiedRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 品类表现（在水果范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator satisfiedRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator satisfiedRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator satisfiedRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.0117` 表示箭头向上但数值为 -1.17 个百分点（即环比下降）。
3. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
4. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
5. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
6. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。