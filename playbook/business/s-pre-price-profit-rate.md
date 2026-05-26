# 定价毛利率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取定价毛利率（`prePriceProfitRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code prePriceProfitRate --full
```

返回字段：`indicatorsName`（定价毛利率）、`businessDefinition`（门店库存可售商品按照公司的价格策略进行正常销售，不做任何的促销和折让，产生的理论毛利额占理论销售收入的比例）、`statisticalLogic`（定价毛利额 / 理论销售额）、`indicatorBiz`（全链路）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator prePriceProfitRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "prePriceProfitRate",
  "indicatorName": "定价毛利率",
  "value": 0.36370126939157105,
  "valueUnit": 3,
  "mom": {
    "value": -0.0012,
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.0046,
    "status": "up",
    "unit": 3
  },
  "threshold": {
    "compareSymbol": "BETWEEN",
    "compareValue1": 30,
    "compareValue2": 32,
    "compareValueType": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 3` -- 小数形式的比率（需 x100 转为百分比，如 0.3637 表示 36.37%）。

定价毛利率的 `valueUnit` 为 3，即返回值为小数比率，显示时需乘以 100 转为百分比。示例中 `value: 0.3637` 表示定价毛利率为 **36.37%**。

**同比/环比的 value**：
- `unit: 3` -- 小数形式的比率变化（百分点）。如 `mom.value: -0.0012` 表示环比变动 **-0.12 个百分点**；`yoy.value: -0.0046` 表示同比变动 **-0.46 个百分点**。

**阈值说明**：
- 定价毛利率的阈值为 `BETWEEN 30-32`（`compareValueType: 2` 表示百分比值），即期望定价毛利率保持在 30%-32% 的区间内。
- `compareSymbol: "BETWEEN"` 表示区间阈值，当前值需落在 `compareValue1` 和 `compareValue2` 之间才达标。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator prePriceProfitRate
```

返回最近约 30 天的逐日定价毛利率数据（current）和同比对照数据（compare）：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)"
  },
  "grouping": "ctime",
  "rows": [
    {
      "period": "2026/05/24",
      "current": 0.3637012693915711,
      "compare": 0.33363635473303316
    },
    {
      "period": "2026/05/23",
      "current": 0.3648983843858695,
      "compare": 0.3171746485245865
    },
    {
      "period": "2026/05/22",
      "current": 0.3619532900546925,
      "compare": 0.3204817213105295
    },
    {
      "period": "2026/05/17",
      "current": 0.36832596437183085,
      "compare": 0.3352506606417613
    }
  ]
}
```

特点：近期定价毛利率在 0.352-0.368 区间波动，整体呈震荡走势，5月17日出现过一次小高峰（0.3683）。当前值同比全部高于去年同期（去年同期对比值在 0.313-0.336 区间）。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator prePriceProfitRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的定价毛利率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.39825371605750853,
      "yoy": { "value": -0.00773, "status": "up", "unit": 3 },
      "mom": { "value": -0.00643, "status": "up", "unit": 3 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.3594241409088388,
      "yoy": { "value": -0.00042, "status": "up", "unit": 3 },
      "mom": { "value": 0.00298, "status": "up", "unit": 3 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.3558315201681019,
      "yoy": { "value": -0.01145, "status": "up", "unit": 3 },
      "mom": { "value": -0.00459, "status": "up", "unit": 3 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0.3444297779253918,
      "yoy": { "value": -0.01160, "status": "up", "unit": 3 },
      "mom": { "value": -0.00571, "status": "up", "unit": 3 }
    }
  ]
}
```

区域定价毛利率排名：华东（39.83%）> 粤东（35.94%）> 粤西（35.58%）> 运营直管（34.44%）。四个区域定价毛利率均高于阈值区间上限 32%。华东定价毛利率显著领先，运营直管为最低区域。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator prePriceProfitRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类定价毛利率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.42709605502940007,
      "yoy": { "value": 0.00415, "unit": 3 },
      "mom": { "value": -0.00237, "unit": 3 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.37721155697788006,
      "yoy": { "value": -0.02049, "unit": 3 },
      "mom": { "value": -0.00173, "unit": 3 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0.3530538077035977,
      "yoy": { "value": -0.00370, "unit": 3 },
      "mom": { "value": -0.01438, "unit": 3 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.3401053328121083,
      "yoy": { "value": -0.00958, "unit": 3 },
      "mom": { "value": -0.00441, "unit": 3 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.3400655698941942,
      "yoy": { "value": 0.00552, "unit": 3 },
      "mom": { "value": 0.00164, "unit": 3 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 0.334451317627926,
      "yoy": { "value": -0.00433, "unit": 3 },
      "mom": { "value": 0.01524, "unit": 3 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 0.32348877994607783,
      "yoy": { "value": 0.00056, "unit": 3 },
      "mom": { "value": -0.01399, "unit": 3 }
    }
  ]
}
```

品类定价毛利率排名：猪肉（42.71%）> 蔬菜（37.72%）> 水产（35.31%）> 冷藏加工（34.01%）> 预制菜（34.01%）> 肉禽蛋（33.45%）> 水果（32.35%）。猪肉定价毛利率最高，水果接近阈值区间上限。

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
  - `管理区域` -> `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东、CN07 运营直管）
  - `督导` -> `groupManagerId`
  - `大区` -> `manageRegionId`
  - `门店` -> `storeId`

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 猪肉` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` -> `categoryLevel1Id`（如 13 猪肉、10 蔬菜、11 水产、26 冷藏加工、25 预制菜、24 肉禽蛋、12 水果）
  - `中分类` -> `categoryLevel2Id`
  - `小分类` -> `categoryLevel3Id`
  - `商品` -> `articleId`

### 6.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

---

## 七、获取子指标数据

定价毛利率的下钻子指标包括：预期毛利率（`preProfitRate`）、出库折让率（`scmPromotionTotalRate`）、时段折扣率（`hourDiscountRate`）、促销折扣率（`promotionDiscountRate`）、损耗率（`lostRate`）。

### 批量获取子指标（含同比、环比）

```bash
qdm-cmr-cli report business indicators \
  --indicator preProfitRate,scmPromotionTotalRate,hourDiscountRate,promotionDiscountRate,lostRate \
  --display-mode yoyMom
```

### 各子指标详情

```bash
qdm-cmr-cli indicator detail --code preProfitRate --full
qdm-cmr-cli indicator detail --code scmPromotionTotalRate --full
qdm-cmr-cli indicator detail --code hourDiscountRate --full
qdm-cmr-cli indicator detail --code promotionDiscountRate --full
qdm-cmr-cli indicator detail --code lostRate --full
```

---

## 八、完整示例

### 示例 1：默认查询（全国、全品类、昨天、含同比环比）

```bash
qdm-cmr-cli report business indicators \
  --indicator prePriceProfitRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 猪肉品类 + 全量数据

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator prePriceProfitRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator prePriceProfitRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator prePriceProfitRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13

# 品类表现（在猪肉范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator prePriceProfitRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator prePriceProfitRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator prePriceProfitRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 九、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 定价毛利率的 `valueUnit` 为 3（小数比率），显示时需乘以 100 转为百分比。例如 `value: 0.3637` 应显示为 **36.37%**。
3. 同比/环比中的 `unit: 3` 表示小数比率变化（百分点）。例如 `mom.value: -0.0012` 表示环比下降 0.12 个百分点。
4. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.0012` 表示箭头向上但数值为 -0.0012（即环比微降）。
5. 阈值为 `BETWEEN 30-32`，当前值 36.37% 高于阈值区间上限 32%，属于定价毛利偏高、需结合折扣和损耗情况综合判断。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。