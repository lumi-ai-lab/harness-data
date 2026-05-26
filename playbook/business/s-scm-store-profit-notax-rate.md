# 供应链毛利率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取供应链毛利率（`scmStoreProfitNotaxRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code scmStoreProfitNotaxRate --full
```

返回字段：`indicatorsName`（供应链到店毛利率（不含税））、`businessDefinition`（仓库配送到门店的商品毛利额占出库到店收入的比例，不含税款）、`statisticalLogic`（供应链到店毛利额（不含税）/(出库到店金额（不含税）-abs(门店退货额（SAP）（不含税）))）、`indicatorBiz`（仓储环节）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator scmStoreProfitNotaxRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "scmStoreProfitNotaxRate",
  "indicatorName": "供应链到店毛利率（不含税）",
  "value": 0.10588,              // 当前值（小数比率，需×100=10.59%）
  "valueUnit": 3,                // 单位类型（3=小数比率需×100转百分比）
  "mom": {
    "value": 0.0026,             // 环比变动（+0.26个百分点）
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.01,              // 同比变动（-1.0个百分点）
    "status": "up",
    "unit": 3
  },
  "threshold": {                 // 阈值配置
    "compareSymbol": "GT",
    "compareValue1": 11.18,
    "compareValue2": 11.18,
    "compareValueType": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.10588 表示 10.59%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量（如 `+0.25` 分）
- `unit: 2` — 比率变化（如 `-0.0533` 表示 -5.33%）
- `unit: 3` — 小数形式的比率变化（如 `0.0026` 表示 +0.26 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator scmStoreProfitNotaxRate
```

返回最近约 30 天的逐日供应链毛利率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/23",
      "current": 0.10332062602115108,
      "compare": 0.11891028254593192
    },
    {
      "period": "2026/05/24",
      "current": 0.10588056558603962,
      "compare": 0.10727567933739865
    }
  ]
}
```

趋势数据中 current 和 compare 均为小数比率（valueUnit: 3），需 ×100 转为百分比。如 `current: 0.1033` 表示当日供应链毛利率为 10.33%。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator scmStoreProfitNotaxRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的供应链毛利率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.12107322335519298,
      "yoy": { "value": 0.005572025237424755 },
      "mom": { "value": 0.002217339189011902 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0.1183482327379744,
      "yoy": { "value": -0.013625719020870009 },
      "mom": { "value": -0.001777303134265093 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.11730769631623675,
      "yoy": { "value": -0.004437049094464976 },
      "mom": { "value": -0.0037663826198309214 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.0944061479894366,
      "yoy": { "value": 0.0034329814781751677 },
      "mom": { "value": 0.009866113274204433 }
    }
  ],
  "sort": {
    "field": "current",
    "order": "DESC"
  }
}
```

区域排名按供应链毛利率从高到低排列。value 均为小数比率（valueUnit: 3），需 ×100 转为百分比。如 `current: 0.1211` 表示粤西供应链毛利率为 12.11%。同比环比 unit 为 3，表示百分点变化。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator scmStoreProfitNotaxRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类供应链毛利率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.1798335505431188,
      "yoy": { "value": -0.01649939703806169 },
      "mom": { "value": -0.0037223545197135888 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.16786988336611844,
      "yoy": { "value": -0.021928559826355914 },
      "mom": { "value": -0.017118339284929368 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0.1154312648555988,
      "yoy": { "value": -0.026792022476080826 },
      "mom": { "value": 0.0029378825063428593 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 0.10297660332005704,
      "yoy": { "value": -0.01604343395453134 },
      "mom": { "value": 0.009566910262996262 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.09425491508954695,
      "yoy": { "value": 0.008292571658369927 },
      "mom": { "value": -0.010430914225672813 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.08929119702575278,
      "yoy": { "value": -0.014390819587012674 },
      "mom": { "value": 0.0028634713862722427 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 0.08260701670347703,
      "yoy": { "value": -0.006977874391393371 },
      "mom": { "value": 0.01703435847579325 }
    }
  ],
  "sort": {
    "field": "current",
    "order": "DESC"
  }
}
```

品类排名按供应链毛利率从高到低排列。value 均为小数比率（valueUnit: 3），需 ×100 转为百分比。如 `current: 0.1798` 表示冷藏加工品类供应链毛利率为 17.98%。同比环比 unit 为 3，表示百分点变化。

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
- 品类过滤与下钻：当指定大分类后，`area` 和 `category` 子命令会在此品类范围内进一步下钻。例如 `--category-type 大分类 --category 12` 时，`category` 子命令会显示该大分类下各中分类的供应链毛利率表现。

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
  --indicator scmStoreProfitNotaxRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 水果品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator scmStoreProfitNotaxRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator scmStoreProfitNotaxRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator scmStoreProfitNotaxRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 品类表现（在水果范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator scmStoreProfitNotaxRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator scmStoreProfitNotaxRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator scmStoreProfitNotaxRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.01` 表示箭头向上但数值为 -1.0 个百分点（即同比下降）。
3. 供应链毛利率 `valueUnit: 3`，值为小数比率（如 0.10588 = 10.59%），同比环比 unit 为 3（百分点变化）。
4. 供应链毛利率阈值 `compareSymbol: "GT"`，`compareValue1: 11.18`，表示需要 >11.18%。
5. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
6. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
7. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
8. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。