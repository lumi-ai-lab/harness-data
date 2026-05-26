# 损耗率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取损耗率（`lostRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code lostRate --full
```

返回字段：`indicatorsName`（损耗率）、`businessDefinition`（由于各种原因导致的门店商品价值减少占门店进货额和期初期末库存差额的比例）、`statisticalLogic`（损耗额 /（进货额+期初库存金额 - 期末库存金额））、`indicatorBiz`（销售经营）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator lostRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "lostRate",
  "indicatorName": "损耗率",
  "value": 0.03270006807638108,    // 当前值（valueUnit=3，需×100=3.27%）
  "valueUnit": 3,                   // 单位类型（3=小数形式的比率，需×100转为百分比）
  "mom": {
    "value": -0.0036,               // 环比变动（-0.36个百分点）
    "status": "down",               // 箭头方向
    "unit": 3
  },
  "yoy": {
    "value": 0.0024,                // 同比变动（+0.24个百分点）
    "status": "down",
    "unit": 3
  },
  "threshold": {                    // 阈值配置
    "compareSymbol": "BETWEEN",
    "compareValue1": 2,
    "compareValue2": 3,
    "compareValueType": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.0327 表示 3.27%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化
- `unit: 3` — 小数形式的比率变化（百分点变化，如 -0.0036 表示 -0.36 个百分点）

**损耗率阈值**：BETWEEN 2% ~ 3%，当前值 3.27% 超出阈值上限（损耗偏高，需关注）。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator lostRate
```

返回最近约 30 天的逐日损耗率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 0.03270006807638108,   // 当前周期值（需×100）
      "compare": 0.02542032403759704    // 同比对照值（去年同期）
    },
    {
      "period": "2026/05/23",
      "current": 0.03628025044037746,
      "compare": 0.025956265816180588
    },
    {
      "period": "2026/04/25",
      "current": 0.03108354006600863,
      "compare": 0.016770156571965043
    }
  ]
}
```

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator lostRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的损耗率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.05606351740544422,
      "yoy": { "value": 0.005566827420038528 },
      "mom": { "value": 0.015535066938627037 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0.04982227328223545,
      "yoy": { "value": 0.004589008132470859 },
      "mom": { "value": -0.0002545477836570706 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.038096879951121036,
      "yoy": { "value": 0.002772174638686127 },
      "mom": { "value": 0.0012291268202262035 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.023617677150024607,
      "yoy": { "value": -0.002170277624498094 },
      "mom": { "value": -0.01897918568635592 }
    }
  ]
}
```

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator lostRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类损耗率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.08685919377421603,
      "yoy": { "value": 0.006053280622955959 },
      "mom": { "value": -0.001542515331656405 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.036616003954682515,
      "yoy": { "value": 0.0053999358916764495 },
      "mom": { "value": -0.006439293334732789 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 0.023536610551055395,
      "yoy": { "value": 0.004294629907552423 },
      "mom": { "value": 0.006250148486363821 }
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
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 猪肉` | 具体品类 |

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
  --indicator lostRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 猪肉品类 + 全量

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator lostRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator lostRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13

# 区域表现
qdm-cmr-cli report business area \
  --indicator lostRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13

# 品类表现
qdm-cmr-cli report business category \
  --indicator lostRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator lostRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator lostRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit=3**：损耗率的 valueUnit 为 3（小数比率），需 ×100 转为百分比显示。如 `0.0327` 表示 3.27%。
2. **同比/环比 unit=3**：yoy/mom 中的 value 也是小数形式，表示百分点的变化。如 `mom.value: -0.0036` 表示环比下降 0.36 个百分点。
3. **阈值区间**：损耗率阈值为 BETWEEN 2% ~ 3%，即值应落在 2% 到 3% 之间。该指标为反向指标，越低越好。
4. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。