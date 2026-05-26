# 19点前PI值指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取19点前PI值（`bf19CategoryStoreCustRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code bf19CategoryStoreCustRate --full
```

返回字段：`indicatorsName`（19点前PI值）、`businessDefinition`（19点前，每个品类/占门店19点前客流的占比）、`statisticalLogic`（19点前品类客数 / 门店19点前客数）、`indicatorsCodeEn`（bf19CategoryStoreCustRate）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator bf19CategoryStoreCustRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "bf19CategoryStoreCustRate",
  "indicatorName": "19点前PI值",
  "value": 1.0,
  "valueUnit": 3,
  "mom": {
    "value": 0,
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": 0,
    "status": "up",
    "unit": 3
  }
}
```

**valueUnit = 3 的含义**：小数形式的比率，需 ×100 转为百分比。如 `value: 1.0` 表示 PI 值为 100%（即 1.0 × 100）。

**同比/环比 unit = 3 的含义**：小数形式的比率变化（百分点变化）。如 `mom.value: 0` 表示环比无变化；`yoy.value: 0` 表示同比无变化。

**PI值无阈值配置**，CLI 未返回 threshold 字段。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 -0.039 表示 -3.9%）
- `unit: 3` — 小数形式的比率变化（如 0 表示 0 个百分点变化）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator bf19CategoryStoreCustRate
```

返回最近约 30 天的逐日19点前PI值数据（current）和同比对照数据（compare）。可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator bf19CategoryStoreCustRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的19点前PI值排名（含同比、环比）。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator bf19CategoryStoreCustRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类19点前PI值排名（含同比、环比）。

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
  - `督导` → `groupManagerId`
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
  --indicator bf19CategoryStoreCustRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 蔬菜品类 + 全量数据

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator bf19CategoryStoreCustRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 10 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator bf19CategoryStoreCustRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 10

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator bf19CategoryStoreCustRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 10

# 品类表现（在蔬菜范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator bf19CategoryStoreCustRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 10
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator bf19CategoryStoreCustRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator bf19CategoryStoreCustRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 3** 表示小数形式的比率，需要 ×100 转为百分比。例如 `value: 1.0` 表示 100%。
2. **同比/环比 unit: 3** 表示百分点变化（小数形式）。如 `mom.value: 0` 表示环比无百分点变化。
3. **PI值无阈值配置**，CLI 未返回 threshold 字段，模板中不展示阈值列。
4. **PI值 = 100%** 在单日全品类视角下为正常现象（品类客数 = 门店客数）。
5. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
6. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
7. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
8. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
9. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
10. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。