# 时段折扣率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取时段折扣率（`hourDiscountRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code hourDiscountRate --full
```

返回字段：`indicatorsName`（时段折扣率）、`businessDefinition`（日清商品在清仓打折时段内产生的折扣金额占全天原价销售额的比例）、`statisticalLogic`（时段折扣额/原价销售额）、`indicatorBiz`（销售经营）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator hourDiscountRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "hourDiscountRate",
  "indicatorName": "时段折扣率",
  "value": 0.12080032862774602,   // 当前值（valueUnit=3，需×100=12.08%）
  "valueUnit": 3,                  // 单位类型（3=小数形式的比率，需×100转为百分比）
  "mom": {
    "value": -0.0048,              // 环比变动（-0.48个百分点）
    "status": "down",              // 箭头方向
    "unit": 3
  },
  "yoy": {
    "value": 0.0052,               // 同比变动（+0.52个百分点）
    "status": "down",
    "unit": 3
  },
  "threshold": {                   // 阈值配置
    "compareSymbol": "BETWEEN",
    "compareValue1": 12.5,
    "compareValue2": 14.5,
    "compareValueType": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1208 表示 12.08%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化
- `unit: 3` — 小数形式的比率变化（百分点变化，如 -0.0048 表示 -0.48 个百分点）

**时段折扣率阈值**：BETWEEN 12.5% ~ 14.5%，当前值 12.08% 略低于阈值下限。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator hourDiscountRate
```

返回最近约 30 天的逐日时段折扣率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 0.120800328627746,    // 当前周期值（需×100）
      "compare": 0.11804146219842526   // 同比对照值（去年同期）
    },
    {
      "period": "2026/05/23",
      "current": 0.12557199756432869,
      "compare": 0.14193534355122583
    },
    {
      "period": "2026/05/16",
      "current": 0.11320880482522114,
      "compare": 0.13528930064999706
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator hourDiscountRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的时段折扣率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.1539642707102188,
      "yoy": { "value": -0.0036389923426622395 },
      "mom": { "value": -0.01800000788050682 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.12401802357034657,
      "yoy": { "value": 0.012257274425634707 },
      "mom": { "value": 0.0016515120388596732 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.12126285144169514,
      "yoy": { "value": 0.012658554554134796 },
      "mom": { "value": 0.0019999232872612016 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0.1112292231935105,
      "yoy": { "value": 0.018773117318468382 },
      "mom": { "value": 0.023762978624305472 }
    }
  ]
}
```

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator hourDiscountRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类时段折扣率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.17186347623536133,
      "yoy": { "value": 0.012509875679568683 },
      "mom": { "value": 0.012524854480611497 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.15847561357482037,
      "yoy": { "value": 0.0036171262999983855 },
      "mom": { "value": -0.016204855977778043 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0.13331067763971433,
      "yoy": { "value": 0.0015898499955867285 },
      "mom": { "value": 0.00189875246750687 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.12020159973868204,
      "yoy": { "value": 0.005870286567075042 },
      "mom": { "value": -0.004921342861319081 }
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

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 预制菜` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。

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
  --indicator hourDiscountRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 预制菜品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator hourDiscountRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 25 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator hourDiscountRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 25

# 区域表现
qdm-cmr-cli report business area \
  --indicator hourDiscountRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 25

# 品类表现
qdm-cmr-cli report business category \
  --indicator hourDiscountRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 25
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator hourDiscountRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator hourDiscountRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit=3**：时段折扣率的 valueUnit 为 3（小数比率），需 ×100 转为百分比显示。如 `0.1208` 表示 12.08%。
2. **同比/环比 unit=3**：yoy/mom 中的 value 也是小数形式，表示百分点的变化。如 `mom.value: -0.0048` 表示环比下降 0.48 个百分点。
3. **阈值区间**：时段折扣率阈值为 BETWEEN 12.5% ~ 14.5%，即值应落在 12.5% 到 14.5% 之间。
4. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。