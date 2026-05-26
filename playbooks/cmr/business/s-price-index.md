# 售价价格指数(线上)指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取售价价格指数(线上)（`priceIndex`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code priceIndex --full
```

返回字段：`indicatorsName`（价格指数）、`businessDefinition`（钱大妈商品B价策略的最大价格跟各品牌对应商品的最大价格的比值）、`statisticalLogic`（价格指数分子/价格指数分母）、`indicatorBiz`（价格管理）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator priceIndex --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "priceIndex",
  "indicatorName": "售价价格指数(线上)",
  "value": 77.77514538489189,
  "valueUnit": 2,
  "mom": {
    "value": -0.03833920898571819,
    "arrowStatus": "down",
    "status": "down",
    "unit": 1
  },
  "yoy": {
    "value": -1.3331939620377113,
    "arrowStatus": "down",
    "status": "down",
    "unit": 1
  },
  "threshold": {
    "compareSymbol": "LT",
    "compareValue1": 100,
    "compareValue2": 100,
    "compareValueType": 2
  }
}
```

**售价价格指数(线上)的 valueUnit = 2**：值为指数数值本身，如 77.78 表示售价价格指数为 77.78。

**同比/环比 unit = 1 的含义**：绝对变化量（指数点变化）。如 `mom.value: -0.0383` 表示环比下降 0.038 个指数点；`yoy.value: -1.3332` 表示同比下降 1.33 个指数点。

**阈值配置**：`compareSymbol: "LT"`（小于），`compareValue1: 100`，即售价价格指数低于 100 表示售价低于品牌对标价格。当前值 77.78 < 100，未达到对标价格水平。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.2646 表示 26.46%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量（如 `-1.33` 表示同比下降 1.33 个指数点）
- `unit: 2` — 比率变化（如 `-0.039` 表示 -3.9%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator priceIndex
```

返回最近约 30 天的逐日售价价格指数数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    {
      "period": "2026/04/25",
      "current": 85.31186929500915,
      "compare": 347.5099467433347
    },
    {
      "period": "2026/05/01",
      "current": 83.1229309736961,
      "compare": 377.266500255419
    },
    {
      "period": "2026/05/05",
      "current": 198.36603710362942,
      "compare": 345.66819523393957
    },
    {
      "period": "2026/05/10",
      "current": 80.5474628524134,
      "compare": 359.46341151856626
    },
    {
      "period": "2026/05/17",
      "current": 79.1083393469296,
      "compare": 356.72885230902585
    },
    {
      "period": "2026/05/24",
      "current": 77.77514538489189,
      "compare": 459.161573005483
    }
  ]
}
```

- 趋势呈持续下滑态势：从 4/25 的 85.31 下降至 5/24 的 77.78（约 -7.5 个指数点）。
- 5/5 出现异常高值 198.37（疑为节假日或数据波动），需关注是否为有效数据。
- 5月中旬后稳定在 77-80 区间，逐渐远离 100 阈值。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator priceIndex
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的售价价格指数排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 80.49142372287805,
      "yoy": { "value": -3.689995282536131, "status": "down", "unit": 1 },
      "mom": { "value": -1.9941376510932827, "status": "down", "unit": 1 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 78.15573176338725,
      "yoy": { "value": 0.18582231310753627, "status": "down", "unit": 1 },
      "mom": { "value": 0.16051373042299133, "status": "down", "unit": 1 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 65.91023630468882,
      "yoy": { "value": -4.18668995787543, "status": "down", "unit": 1 },
      "mom": { "value": -1.5357288235364592, "status": "down", "unit": 1 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": null,
      "yoy": { "value": null, "status": "down", "unit": 1 },
      "mom": { "value": null, "status": "down", "unit": 1 }
    }
  ]
}
```

区域排名：粤东（80.49）> 粤西（78.16）> 华东（65.91）。运营直管无数据。所有区域均低于 100 阈值，华东最为严重，比粤东低约 14.6 个指数点。全部区域 yoy/mom 的 unit 均为 1（绝对变化量，指数点）。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator priceIndex
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回各品类的售价价格指数排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "11",
      "name": "水产",
      "current": 91.81966292052935,
      "yoy": { "value": 6.765092312134129, "status": "down", "unit": 1 },
      "mom": { "value": 4.947588435070855, "status": "down", "unit": 1 },
      "threshold": { "compareSymbol": "LT", "compareValue1": 95, "compareValue2": 95 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 88.58747552271866,
      "yoy": { "value": -0.3804645062826211, "status": "down", "unit": 1 },
      "mom": { "value": 2.211508098702268, "status": "down", "unit": 1 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 85.75599575359276,
      "yoy": { "value": -2.6156916492186753, "status": "down", "unit": 1 },
      "mom": { "value": -1.7338345727789601, "status": "down", "unit": 1 },
      "threshold": { "compareSymbol": "LT", "compareValue1": 90, "compareValue2": 90 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 85.3479838847909,
      "yoy": { "value": -5.069959835023127, "status": "down", "unit": 1 },
      "mom": { "value": 1.4327271706245455, "status": "down", "unit": 1 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 84.02189659087685,
      "yoy": { "value": -0.39140846611613256, "status": "down", "unit": 1 },
      "mom": { "value": 1.5918430753152535, "status": "down", "unit": 1 },
      "threshold": { "compareSymbol": "LT", "compareValue1": 85, "compareValue2": 85 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 79.87898231231172,
      "yoy": { "value": -2.264230597903463, "status": "down", "unit": 1 },
      "mom": { "value": -1.2611928665317436, "status": "down", "unit": 1 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 67.21455371755093,
      "yoy": { "value": -1.9204192035593053, "status": "down", "unit": 1 },
      "mom": { "value": -0.23372902038431675, "status": "down", "unit": 1 },
      "threshold": { "compareSymbol": "LT", "compareValue1": 80, "compareValue2": 80 }
    }
  ]
}
```

品类排名：水产（91.82）> 肉禽蛋（88.59）> 冷藏加工（85.76）> 水果（85.35）> 预制菜（84.02）> 猪肉（79.88）> 蔬菜（67.21）。

品类分级阈值：水产 <95、冷藏加工 <90、预制菜 <85、蔬菜 <80。水产是唯一同环比双增的品类（yoy +6.77, mom +4.95），最接近阈值；蔬菜最低（67.21），价格竞争力最弱。所有品类 yoy/mom 的 unit 均为 1（绝对变化量，指数点）。

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
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 水产` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` → `categoryLevel1Id`（如 11 水产、24 肉禽蛋、26 冷藏加工、12 水果、25 预制菜、13 猪肉、10 蔬菜）
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
  --indicator priceIndex \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤东区域 + 水产品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator priceIndex \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 11 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator priceIndex \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 11

# 区域表现（在粤东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator priceIndex \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 11

# 品类表现（在水产范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator priceIndex \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 11
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator priceIndex \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：查看采购价格指数（下钻子指标）

```bash
qdm-cmr-cli report business indicators \
  --indicator purchasePriceIndex \
  --display-mode yoyMom
```

### 示例 5：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator priceIndex \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化量；**环比（mom）** = 与上一个周期对比的变化量。售价价格指数的 yoy/mom 的 unit 为 `1`（绝对变化量，指数点）。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。例如 `status: "down"` 且 `value: -0.0383` 表示箭头向下、数值为 -0.038（即环比下降 0.038 个指数点）。
3. 阈值 `compareSymbol: "LT"`，`compareValue1: 100` 表示售价价格指数低于 100 即为低于品牌对标价格水平。当前值 77.78 < 100。
4. `valueUnit: 2` 表示值为比率/指数数值，直接使用即可，无需 ×100 转换。
5. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
6. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
7. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
8. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。