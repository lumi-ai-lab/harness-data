# 出库折让率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取出库折让率（`scmPromotionTotalRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code scmPromotionTotalRate --full
```

返回字段：`indicatorsName`（出库折让率）、`businessDefinition`（出库让利总额占预期出库到店金额的占比）、`statisticalLogic`（出库让利总额/(出库到店金额+出库让利总额)）、`indicatorBiz`（营销策略）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator scmPromotionTotalRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "scmPromotionTotalRate",
  "indicatorName": "出库折让率",
  "value": 0.04291752884265983,
  "valueUnit": 3,
  "mom": {
    "value": 0.0054,
    "status": "down",
    "unit": 3
  },
  "yoy": {
    "value": -0.0011,
    "status": "down",
    "unit": 3
  },
  "threshold": {
    "compareSymbol": "LE",
    "compareValue1": 3.5,
    "compareValue2": 3.5,
    "compareValueType": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比，如 0.0429 表示 4.29%）。

出库折让率的 `valueUnit` 为 3，即返回值为小数比率，显示时需乘以 100 转为百分比。示例中 `value: 0.0429` 表示出库折让率为 **4.29%**。

**同比/环比的 value**：
- `unit: 3` — 小数形式的比率变化（百分点）。如 `mom.value: 0.0054` 表示环比变动 **+0.54 个百分点**（折让率上升，为恶化）；`yoy.value: -0.0011` 表示同比变动 **-0.11 个百分点**（折让率下降，为改善）。

**阈值说明**：
- 出库折让率的阈值为 `LE 3.5`（`compareValueType: 2` 表示百分比值），即出库折让率应 **小于等于 3.5%**。
- 该指标为负向指标：值越低越好。阈值 `LE` 表示超过上限即为不达标。
- `mom.status: "down"` 和 `yoy.status: "down"` 表示箭头向下，但当折让率上升时箭头指向下通常代表恶化。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator scmPromotionTotalRate
```

返回最近约 30 天的逐日出库折让率数据（current）和同比对照数据（compare）：

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
      "current": 0.04291752884265983,
      "compare": 0.025812930889858327
    },
    {
      "period": "2026/05/23",
      "current": 0.037534015092663825,
      "compare": 0.020697105420303806
    },
    {
      "period": "2026/05/22",
      "current": 0.038169855970710785,
      "compare": 0.024170212265122573
    },
    {
      "period": "2026/05/21",
      "current": 0.02865839984840211,
      "compare": 0.019700831018191547
    },
    {
      "period": "2026/05/17",
      "current": 0.04402579881953376,
      "compare": 0.027827742237567395
    },
    {
      "period": "2026/05/04",
      "current": 0.023232597115510407,
      "compare": 0.021386832559887367
    }
  ]
}
```

特点：近期出库折让率在 0.023-0.048 区间波动，整体呈震荡走势。5月4日出现近30天最低点（0.0232），5月17日出现近30天高点（0.0440）。近期趋势偏上行，5月24日较前期明显升高。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator scmPromotionTotalRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的出库折让率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.07358206787436895,
      "yoy": { "value": 0.00525, "status": "down", "unit": 3 },
      "mom": { "value": 0.00756, "status": "down", "unit": 3 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.050393009083407166,
      "yoy": { "value": 0.00120, "status": "down", "unit": 3 },
      "mom": { "value": 0.02438, "status": "down", "unit": 3 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0.04247677527244816,
      "yoy": { "value": 0.00974, "status": "down", "unit": 3 },
      "mom": { "value": 0.01776, "status": "down", "unit": 3 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.041895288061497345,
      "yoy": { "value": -0.00419, "status": "down", "unit": 3 },
      "mom": { "value": -0.00645, "status": "down", "unit": 3 }
    }
  ]
}
```

区域出库折让率排名（由高到低，折让越高说明让利越多）：华东（7.36%）> 粤西（5.04%）> 运营直管（4.25%）> 粤东（4.19%）。阈值对所有区域统一为 LE 3.5%。所有区域均超出阈值上限，尤以华东最为严重。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator scmPromotionTotalRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类出库折让率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.10599687642611134,
      "yoy": { "value": 0.01514, "unit": 3 },
      "mom": { "value": 0.00443, "unit": 3 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.05152371361365974,
      "yoy": { "value": 0.00142, "unit": 3 },
      "mom": { "value": 0.00125, "unit": 3 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 0.04915496229175639,
      "yoy": { "value": -0.01607, "unit": 3 },
      "mom": { "value": 0.01989, "unit": 3 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.03879780225502236,
      "yoy": { "value": 0.00077, "unit": 3 },
      "mom": { "value": 0.00655, "unit": 3 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.03418547664358938,
      "yoy": { "value": -0.02419, "unit": 3 },
      "mom": { "value": -0.00192, "unit": 3 }
    }
  ]
}
```

品类出库折让率排名（由高到低）：冷藏加工（10.60%）> 猪肉（5.15%）> 水果（4.92%）> 蔬菜（3.88%）> 预制菜（3.42%）。冷藏加工品类折让率远超其他品类，为全国整体折让率的主要推高因素。

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
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 冷藏加工` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` -> `categoryLevel1Id`（如 26 冷藏加工、13 猪肉、12 水果、10 蔬菜、25 预制菜、11 水产、24 肉禽蛋）
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

## 七、完整示例

### 示例 1：默认查询（全国、全品类、昨天、含同比环比）

```bash
qdm-cmr-cli report business indicators \
  --indicator scmPromotionTotalRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 冷藏加工品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator scmPromotionTotalRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 26 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator scmPromotionTotalRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 26
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator scmPromotionTotalRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator scmPromotionTotalRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 出库折让率的 `valueUnit` 为 3（小数比率），显示时需乘以 100 转为百分比。例如 `value: 0.0429` 应显示为 **4.29%**。
3. 同比/环比中的 `unit: 3` 表示小数比率变化（百分点）。例如 `mom.value: 0.0054` 表示环比上升 0.54 个百分点（折让率恶化）。
4. 出库折让率为**负向指标**（越低越好）。折让率上升代表让利增加、毛利被侵蚀；折让率下降代表让利减少、毛利改善。
5. `mom.status: "down"` 且 `mom.value: 0.0054` 表示箭头向下但数值为正（折让率上升），通常代表恶化信号。解读时需结合指标方向判断。
6. 阈值为 `LE 3.5`，当前值 4.29% 超出阈值上限。如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。
10. 出库折让率虽然 code 中包含"scm"，但固定归入品效维度（定价毛利率拆解链路），不可放入供应链章节。