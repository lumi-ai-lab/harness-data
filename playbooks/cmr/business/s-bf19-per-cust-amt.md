# 19点前客单价指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取19点前客单价（`bf19PerCustAmt`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code bf19PerCustAmt --full
```

返回字段：`indicatorsName`（19点前客单价）、`businessDefinition`（清仓时段前每笔订单的平均消费金额）、`statisticalLogic`（19点前销售额 / 19点前客数）、`indicatorBiz`（销售经营）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator bf19PerCustAmt --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "bf19PerCustAmt",
  "indicatorName": "19点前客单价",
  "value": 33.375057546062365,
  "valueUnit": 2,
  "mom": {
    "value": -0.0509,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.3769,
    "status": "up",
    "unit": 2
  },
  "threshold": {
    "compareSymbol": "GT",
    "compareValue1": 19.2,
    "compareValue2": 19.2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` -- 整数值（如客数、门店数）
- `valueUnit: 2` -- 百分比/比率/金额（直接用值，如 33.38 表示19点前客单价为 33.38 元）
- `valueUnit: 3` -- 小数形式的比率（需 x100 转为百分比）

**同比/环比的 value**：
- `unit: 1` -- 绝对变化量
- `unit: 2` -- 比率变化（如 `-0.0509` 表示 -5.09%，`0.3769` 表示 +37.69%）
- `unit: 3` -- 小数形式的比率变化（百分点变化）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator bf19PerCustAmt
```

返回最近约 30 天的逐日19点前客单价数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 33.37505754606237,
      "compare": 27.097736206524477
    },
    {
      "period": "2026/05/23",
      "current": 35.163546111864996,
      "compare": 23.261476258024548
    },
    {
      "period": "2026/05/22",
      "current": 28.487160178297717,
      "compare": 21.957970303378392
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator bf19PerCustAmt
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的19点前客单价排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 26.593832207899467,
      "yoy": { "value": 0.016501548896248355 },
      "mom": { "value": -0.06763752422613455 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 23.663380607742717,
      "yoy": { "value": 0.013199407735909122 },
      "mom": { "value": -0.06754414403969228 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 22.242891468682505,
      "yoy": { "value": 0.016750946239910344 },
      "mom": { "value": -0.1280498929164447 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 21.58772450326167,
      "yoy": { "value": 0.04514780590329013 },
      "mom": { "value": 0.0893381207250963 }
    }
  ]
}
```

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator bf19PerCustAmt
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类19点前客单价排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 41.9493040844011,
      "yoy": { "value": 0.358836293793181 },
      "mom": { "value": 0.012397565408870046 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 30.870348628249676,
      "yoy": { "value": 0.40750293751988115 },
      "mom": { "value": -0.055623964482320376 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 27.93708631271381,
      "yoy": { "value": 0.33339472239830614 },
      "mom": { "value": -0.01016053632424174 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 27.369229326709654,
      "yoy": { "value": 0.27461671556025175 },
      "mom": { "value": 0.012368482623307808 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 26.39436978310276,
      "yoy": { "value": 0.2592008528931803 },
      "mom": { "value": -0.24830230137844203 }
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
  - `管理区域` -> `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` -> `groupManagerId`
  - `大区` -> `manageRegionId`
  - `门店` -> `storeId`

### 6.3 品类过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--category-type` | `大分类` / `中分类` / `小分类` / `商品` | `--category-type 大分类` | 品类维度类型 |
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 水果` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` -> `categoryLevel1Id`（如 12 水果、13 猪肉、10 蔬菜、11 水产、24 肉禽蛋）
  - `中分类` -> `categoryLevel2Id`
  - `小分类` -> `categoryLevel3Id`
  - `商品` -> `articleId`
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
  --indicator bf19PerCustAmt \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 水果品类 + 全量数据

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator bf19PerCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator bf19PerCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator bf19PerCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 品类表现（在水果范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator bf19PerCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator bf19PerCustAmt \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator bf19PerCustAmt \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 2** 表示金额/比率类值，直接使用。例如 `value: 33.38` 表示19点前客单价为 33.38 元。
2. **同比/环比 unit: 2** 表示比率变化。如 `mom.value: -0.0509` 表示环比下降 5.09%；`yoy.value: 0.3769` 表示同比上升 37.69%。
3. **阈值**：阈值目标为 >19.2（`compareSymbol: "GT"`），当前值 33.38 已超过阈值。
4. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。