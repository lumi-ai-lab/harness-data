# 19点前客数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取19点前客数（`bf19CustNum`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code bf19CustNum --full
```

返回字段：`indicatorsName`（19点前客数）、`businessDefinition`（清仓时段前消费的顾客订单数）、`statisticalLogic`（门店清仓时段前的来客数）、`indicatorBiz`（销售经营）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator bf19CustNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "bf19CustNum",
  "indicatorName": "19点前客数",
  "value": 465.2219178082192,
  "valueUnit": 1,
  "mom": {
    "arrowStatus": "up",
    "status": "up",
    "unit": 2,
    "value": 0.0091
  },
  "yoy": {
    "arrowStatus": "up",
    "status": "up",
    "unit": 2,
    "value": -0.0286
  },
  "threshold": {
    "compareSymbol": "GT",
    "compareValue1": 413,
    "compareValue2": 413,
    "compareValueType": 2
  }
}
```

**valueUnit = 1 的含义**：整数值（如客数、门店数）。如 `value: 465.22` 表示当前19点前客数为 465.22。

**valueUnit 类型对照**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比）

**同比/环比 unit 类型**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 -0.0286 表示 -2.86%）
- `unit: 3` — 小数形式的比率变化（如 0.011 表示 +1.1 个百分点）

**阈值配置**：`compareSymbol: "GT"`（大于），`compareValue1: 413`，即19点前客数阈值目标 >413。当前值 465.22 达标（465.22 > 413）。

**同比/环比中的 status**：`status: "up"` 且 `value: -0.0286` 表示箭头向上但同比数值为负（-2.86%）。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator bf19CustNum
```

返回最近约 30 天的逐日19点前客数数据（`current`）和同比对照数据（`compare`）。

**真实趋势数据（2026/04/25 ~ 2026/05/24）**：

```json
[
  { "current": 472.57, "compare": 396.53, "period": "2026/04/25" },
  { "current": 476.19, "compare": 468.31, "period": "2026/04/26" },
  { "current": 398.24, "compare": 409.71, "period": "2026/04/27" },
  { "current": 399.05, "compare": 377.60, "period": "2026/04/28" },
  { "current": 393.19, "compare": 375.12, "period": "2026/04/29" },
  { "current": 400.78, "compare": 380.53, "period": "2026/04/30" },
  { "current": 391.24, "compare": 370.01, "period": "2026/05/01" },
  { "current": 358.68, "compare": 325.03, "period": "2026/05/02" },
  { "current": 349.52, "compare": 335.69, "period": "2026/05/03" },
  { "current": 380.88, "compare": 370.70, "period": "2026/05/04" },
  { "current": 421.16, "compare": 415.81, "period": "2026/05/05" },
  { "current": 402.42, "compare": 381.16, "period": "2026/05/06" },
  { "current": 411.76, "compare": 381.47, "period": "2026/05/07" },
  { "current": 409.02, "compare": 401.29, "period": "2026/05/08" },
  { "current": 411.40, "compare": 379.45, "period": "2026/05/09" },
  { "current": 458.90, "compare": 449.69, "period": "2026/05/10" },
  { "current": 390.57, "compare": 452.72, "period": "2026/05/11" },
  { "current": 409.79, "compare": 389.57, "period": "2026/05/12" },
  { "current": 409.18, "compare": 404.88, "period": "2026/05/13" },
  { "current": 400.06, "compare": 406.57, "period": "2026/05/14" },
  { "current": 409.50, "compare": 396.47, "period": "2026/05/15" },
  { "current": 481.24, "compare": 390.89, "period": "2026/05/16" },
  { "current": 478.92, "compare": 452.89, "period": "2026/05/17" },
  { "current": 401.13, "compare": 465.73, "period": "2026/05/18" },
  { "current": 396.95, "compare": 388.72, "period": "2026/05/19" },
  { "current": 383.09, "compare": 394.90, "period": "2026/05/20" },
  { "current": 396.64, "compare": 396.74, "period": "2026/05/21" },
  { "current": 422.66, "compare": 403.57, "period": "2026/05/22" },
  { "current": 461.01, "compare": 390.55, "period": "2026/05/23" },
  { "current": 465.22, "compare": 469.39, "period": "2026/05/24" }
]
```

- 趋势范围：349.52（05/03 最低） ~ 481.24（05/16 最高）。
- 低点出现在 05/02 ~ 05/04（五一假期偏低），之后逐步回升。
- 可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator bf19CustNum
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的19点前客数排名（含同比、环比）。

**真实区域排名（2026-05-24，全国不含港澳）**：

```json
[
  { "code": "CN07", "name": "运营直管", "current": 617.33, "mom": -0.0594, "yoy": 0.2509 },
  { "code": "CN15", "name": "华东", "current": 501.63, "mom": -0.0331, "yoy": -0.0790 },
  { "code": "CN18", "name": "粤东", "current": 479.42, "mom": 0.0234, "yoy": -0.0351 },
  { "code": "CN01", "name": "粤西", "current": 445.54, "mom": 0.0071, "yoy": -0.0131 }
]
```

- 运营直管最高（617.33），同比增长显著（+25.09%）。
- 华东次之（501.63），但同比下滑 7.90%。
- 粤东和粤西均同比下降（-3.51%、-1.31%）。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator bf19CustNum
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类19点前客数排名（含同比、环比）。

**真实品类排名（2026-05-24，全国不含港澳）**：

```json
[
  { "code": "10", "name": "蔬菜", "current": 333.21, "mom": 0.0185, "yoy": -0.0251 },
  { "code": "13", "name": "猪肉", "current": 124.40, "mom": 0.0000, "yoy": -0.0340 },
  { "code": "26", "name": "冷藏加工", "current": 96.46, "mom": -0.0100, "yoy": -0.0050 },
  { "code": "12", "name": "水果", "current": 87.20, "mom": 0.1148, "yoy": 0.0317 },
  { "code": "24", "name": "肉禽蛋", "current": 64.96, "mom": 0.0472, "yoy": -0.0147 },
  { "code": "11", "name": "水产", "current": 38.13, "mom": -0.1602, "yoy": -0.0092 },
  { "code": "25", "name": "预制菜", "current": 27.77, "mom": -0.1176, "yoy": -0.0434 }
]
```

- 蔬菜占比最大（333.21，占总客数约 71.6%），水果环比大幅增长（+11.48%）、同比增长（+3.17%）。
- 水产环比大幅下滑（-16.02%），预制菜环比也明显下滑（-11.76%）。

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
| `--category` | 对应类型的 ID 或名称 | `--category 10` / `--category 蔬菜` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` -> `categoryLevel1Id`（如 10 蔬菜、13 猪肉、11 水产、12 水果、24 肉禽蛋、25 预制菜、26 冷藏加工）
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
  --indicator bf19CustNum \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 全品类

```bash
qdm-cmr-cli report business indicators \
  --indicator bf19CustNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom

qdm-cmr-cli report business trend \
  --indicator bf19CustNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15
```

### 示例 3：蔬菜品类 + 粤西区域

```bash
qdm-cmr-cli report business indicators \
  --indicator bf19CustNum \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator bf19CustNum \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 1** 表示整数值，直接使用，无需转换。
2. **同比/环比 unit: 2** 表示比率变化。如 `mom.value: 0.0091` 表示环比 +0.91%；`yoy.value: -0.0286` 表示同比 -2.86%。
3. **阈值**：阈值目标为 >413（`compareSymbol: "GT"`）。当前值 465.22 达标。
4. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
6. 父指标为客数 `custNum`，上级为客数渗透率 `custPenetrationRate`，子指标为19点前PI值 `bf19CategoryStoreCustRate`、19点前复购率 `bf19MemberRepurchaseRate`。
7. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
8. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
9. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
10. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。
11. 时间默认是昨天，区域默认是全国（管理区域 CN00），品类默认是全品类（不限）。
12. 子指标 `bf19MemberRepurchaseRate`（19点前复购率）可能返回 `value: 0`，此时必须按 CLI 事实谨慎描述，不得自行解释为数据缺失、会员流失或活动原因。