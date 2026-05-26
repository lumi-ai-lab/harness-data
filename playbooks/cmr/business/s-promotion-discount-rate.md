# 促销折扣率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取促销折扣率（`promotionDiscountRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code promotionDiscountRate --full
```

返回字段：`indicatorsName`（促销折扣率）、`businessDefinition`（促销折扣额占原价销售额的比例）、`statisticalLogic`（促销折扣额/原价销售额）、`indicatorBiz`（销售经营,全链路）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator promotionDiscountRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "promotionDiscountRate",
  "indicatorName": "促销折扣率",
  "value": 0.10892858318525224,   // 当前值（valueUnit=3，需×100=10.89%）
  "valueUnit": 3,                  // 单位类型（3=小数形式的比率，需×100转为百分比）
  "mom": {
    "value": -0.0075,              // 环比变动（-0.75个百分点）
    "status": "down",              // 箭头方向
    "unit": 3
  },
  "yoy": {
    "value": -0.0012,              // 同比变动（-0.12个百分点）
    "status": "down",
    "unit": 3
  },
  "threshold": {                   // 阈值配置
    "compareSymbol": "BETWEEN",
    "compareValue1": 6,
    "compareValue2": 8.5,
    "compareValueType": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1089 表示 10.89%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化
- `unit: 3` — 小数形式的比率变化（百分点变化，如 -0.0075 表示 -0.75 个百分点）

**促销折扣率阈值**：BETWEEN 6% ~ 8.5%，当前值 10.89% 超出阈值上限（促销折扣偏高）。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator promotionDiscountRate
```

返回最近约 30 天的逐日促销折扣率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 0.10892858318525225,  // 当前周期值（需×100）
      "compare": 0.07414977825795153   // 同比对照值（去年同期）
    },
    {
      "period": "2026/05/23",
      "current": 0.1164501323394919,
      "compare": 0.05636756208785922
    },
    {
      "period": "2026/05/10",
      "current": 0.12929477774086962,  // 近30日峰值
      "compare": 0.08332179442678324
    },
    {
      "period": "2026/05/04",
      "current": 0.08399554131595639,  // 近30日谷值
      "compare": 0.05623695556369733
    },
    {
      "period": "2026/04/25",
      "current": 0.12334054778510475,
      "compare": 0.05629598662300984
    }
  ]
}
```

- 趋势说明：近30天促销折扣率在 8.40% ~ 12.93% 之间波动，整体高于去年同期（去年同期约 4.9% ~ 8.3%）。
- 可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator promotionDiscountRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的促销折扣率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.17140008966443743,
      "yoy": { "value": 0.0018030692019954109 },
      "mom": { "value": 0.011051825900031037 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0.10959852678126449,
      "yoy": { "value": -0.008614787430189466 },
      "mom": { "value": -0.027538762066953618 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.09278514097027236,
      "yoy": { "value": -0.00833239949275251 },
      "mom": { "value": -0.011580058438129273 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.08981234989838076,
      "yoy": { "value": -0.001294307797014435 },
      "mom": { "value": -0.012548711898583517 }
    }
  ]
}
```

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator promotionDiscountRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类促销折扣率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "12",
      "name": "水果",
      "current": 0.12165324092467014,
      "yoy": { "value": -0.007379174585372503 },
      "mom": { "value": -0.02861990217762546 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 0.1192609915685963,
      "yoy": { "value": 0.008315013188525969 },
      "mom": { "value": 0.0073485331318209335 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.11835398107842343,
      "yoy": { "value": -0.010209117876418818 },
      "mom": { "value": -0.0004396945872454511 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.10153469242205909,
      "yoy": { "value": -0.0010287798762960987 },
      "mom": { "value": -0.0012160035345960413 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.10017693041426655,
      "yoy": { "value": 0.017667317996740692 },
      "mom": { "value": 0.007794738590317513 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0.09691797436060623,
      "yoy": { "value": -0.00425994243603478 },
      "mom": { "value": -0.03839187041641376 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.06556930804713497,
      "yoy": { "value": -0.001681273886048995 },
      "mom": { "value": -0.005862615480535183 }
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
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 水果` | 具体品类 |

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
  --indicator promotionDiscountRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 水果品类 + 全量

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator promotionDiscountRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator promotionDiscountRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 区域表现
qdm-cmr-cli report business area \
  --indicator promotionDiscountRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12

# 品类表现
qdm-cmr-cli report business category \
  --indicator promotionDiscountRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 12
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator promotionDiscountRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator promotionDiscountRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit=3**：促销折扣率的 valueUnit 为 3（小数比率），需 ×100 转为百分比显示。如 `0.1089` 表示 10.89%。
2. **同比/环比 unit=3**：yoy/mom 中的 value 也是小数形式，表示百分点的变化。如 `mom.value: -0.0075` 表示环比下降 0.75 个百分点。
3. **阈值区间**：促销折扣率阈值为 BETWEEN 6% ~ 8.5%，即值应落在 6% 到 8.5% 之间。
4. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。