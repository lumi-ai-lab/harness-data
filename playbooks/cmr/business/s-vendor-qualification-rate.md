# 合格率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取合格率（`vendorQualificationRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code vendorQualificationRate --full
```

返回字段：`indicatorsName`（供应商合格率）、`businessDefinition`（供应商送货质量符合标准的次数占总送货次数的比例）、`statisticalLogic`（供应商合格次数/供应商送货次数）、`indicatorBiz`（采购环节）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator vendorQualificationRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "vendorQualificationRate",
  "indicatorName": "合格率",
  "value": 0.9928222199105378,  // 当前值
  "valueUnit": 3,               // 单位类型（3=小数形式的比率，需 ×100 转为百分比）
  "mom": {
    "value": 0.0016,            // 环比变动（+0.16 个百分点）
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.0014,           // 同比变动（-0.14 个百分点）
    "status": "up",
    "unit": 3
  },
  "threshold": {                // 阈值配置
    "compareSymbol": "GE",
    "compareValue1": 99,
    "compareValue2": 99,
    "compareValueType": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、供应商数）
- `valueUnit: 2` — 百分比/比率/金额（直接使用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.9928 表示 99.28%）

**同比/环比的 unit**：
- `unit: 1` — 绝对变化量（如 `+0.25` 分）
- `unit: 2` — 比率变化（如 `-0.039` 表示 -3.9%）
- `unit: 3` — 小数形式的比率变化（如 `0.0016` 表示 +0.16 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator vendorQualificationRate
```

返回最近约 30 天的逐日合格率数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    {
      "period": "2026/05/24",
      "current": 0.9928222199105378,   // 当前周期值（99.28%）
      "compare": 0.9904741744284504    // 同比对照值（去年同期，99.05%）
    },
    {
      "period": "2026/05/01",
      "current": 0.9852802415550104,   // 五一假期的低谷值（98.53%）
      "compare": 0.9935335836462245
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator vendorQualificationRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的合格率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "sort": { "field": "current", "order": "DESC" },
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.9950442477876106,   // 99.50%，领先区域
      "yoy": { "value": 0.0005107200908175402 },
      "mom": { "value": 0.0019336725206453576 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.9918509895227008,   // 99.19%
      "yoy": { "value": -0.003454174796548082 },
      "mom": { "value": -0.005873697621781582 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.9903038138332256,   // 99.03%，偏低区域
      "yoy": { "value": -0.002782295531953527 },
      "mom": { "value": 0.004096917281501522 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0,
      "yoy": { "value": 0 },
      "mom": { "value": 0 }
    }
  ]
}
```

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator vendorQualificationRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类合格率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "sort": { "field": "current", "order": "DESC" },
  "rows": [
    {
      "code": "25",
      "name": "预制菜",
      "current": 1,                     // 100%，满分品类
      "yoy": { "value": 0 },
      "mom": { "value": 0 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 1,                     // 100%，满分品类
      "yoy": { "value": 0 },
      "mom": { "value": 0.0030674846625766694 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.9992343032159265,    // 99.92%
      "yoy": { "value": 0.00022440222582753577 },
      "mom": { "value": -0.0007656967840734552 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.9983031674208145,    // 99.83%
      "yoy": { "value": -0.0016968325791855143 },
      "mom": { "value": -0.0011449561994946178 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 0.9974533106960951,    // 99.75%
      "yoy": { "value": -0.002546689303904892 },
      "mom": { "value": 0.006551739149362246 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.9841680129240711,    // 98.42%，偏低品类
      "yoy": { "value": 0.0017951315681389302 },
      "mom": { "value": 0.0005099362427385401 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 0.981294964028777,     // 98.13%，最低品类
      "yoy": { "value": -0.009150895843834439 },
      "mom": { "value": 0.004086986820799776 }
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
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 粤西` | 具体区域 |

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
  - `中分类` → `categoryLevel2Id`
  - `小分类` → `categoryLevel3Id`
  - `商品` → `articleId`
- 品类过滤与下钻：当指定大分类后，`area` 和 `category` 子命令会在此品类范围内进一步下钻。例如 `--category-type 大分类 --category 12` 时，`category` 子命令会显示水果大分类下各中分类的合格率表现。

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
  --indicator vendorQualificationRate \
  --display-mode yoyMom
```

返回数据（2026-05-24）：合格率当前值为 0.9928（99.28%），阈值 GE 99%，达标。环比 +0.0016（+0.16pp），同比 -0.0014（-0.14pp）。

### 示例 2：指定日期 + 粤西区域 + 水产品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator vendorQualificationRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 11 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator vendorQualificationRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 11

# 区域表现（在粤西范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator vendorQualificationRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 11

# 品类表现（在水产范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator vendorQualificationRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 11
```

### 示例 3：月度汇总 + 华东区域

```bash
qdm-cmr-cli report business indicators \
  --indicator vendorQualificationRate \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator vendorQualificationRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 合格率的 `valueUnit: 3` 表示值为小数形式比率，需 ×100 转为百分比（如 0.9928 = 99.28%）。
3. 同比/环比 `unit: 3` 表示变化量为小数形式，直接即为百分点变化（如 0.0016 = +0.16 个百分点）。
4. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
5. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
6. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
7. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
8. 合格率是履约质量三率之一，分析时建议同步获取三率综合得分（`threeRateScore`）、准点率（`vendorIntimeRate`）、准确率（`vendorAccuracyRate`）进行交叉验证。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。
10. 运营直管（CN07）区域的合格率当前值为 0，可能是该区域暂无供应商送货数据或数据未覆盖。