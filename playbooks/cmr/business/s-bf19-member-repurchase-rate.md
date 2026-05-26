# 19点前复购率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取19点前复购率（`bf19MemberRepurchaseRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code bf19MemberRepurchaseRate --full
```

返回字段：

| 字段 | 值 |
| :--- | :--- |
| `indicatorsName` | 19点前滚动7天会员复购率 |
| `indicatorsCodeEn` | bf19MemberRepurchaseRate |
| `businessDefinition` | T天购买b分类的会员中，在T+1~T+7天19点前内复购同分类的比例（若需统计全品类，则不考虑商品分类） |
| `statisticalLogic` | 19点前滚动7天复购会员数 / 消费会员数 |
| `indicatorBiz` | 销售经营 |
| `id` | 1906611307212607489 |

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator bf19MemberRepurchaseRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "bf19MemberRepurchaseRate",
  "indicatorName": "19点前复购率",
  "value": 0,
  "valueUnit": 3,
  "mom": {
    "value": -0.2322,
    "arrowStatus": "up",
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.6107,
    "arrowStatus": "up",
    "status": "up",
    "unit": 3
  },
  "threshold": null
}
```

**valueUnit = 3 的含义**：小数形式的比率，需 x100 转为百分比。如 `value: 0` 表示复购率为 0%。

**同比/环比 unit = 3 的含义**：小数形式的比率变化（百分点变化）。如 `mom.value: -0.2322` 表示环比下降 23.22 个百分点；`yoy.value: -0.6107` 表示同比下降 61.07 个百分点。

**复购率在单日为 0**：滚动7天复购率在单日快照中返回 0 是正常现象（单日快照无法反映滚动窗口的复购行为），在模板中必须按 CLI 事实谨慎描述，不得自行解释为会员流失、系统异常或活动原因。

**复购率无阈值配置**：CLI 返回 `threshold: null`，模板中不展示阈值列。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` -- 整数值（如客数、门店数）
- `valueUnit: 2` -- 百分比/比率/金额（直接用值）
- `valueUnit: 3` -- 小数形式的比率（需 x100 转为百分比）

**同比/环比的 value**：
- `unit: 1` -- 绝对变化量
- `unit: 2` -- 比率变化（如 -0.039 表示 -3.9%）
- `unit: 3` -- 小数形式的比率变化（如 -0.2322 表示 -23.22 个百分点）

### 父级链路指标同时返回

CLI 在同一次 `report business indicators` 调用中会返回全量指标，可在 items 数组中提取父级链路指标：

| 指标 | code | 典型值(2026-05-24) | valueUnit |
| :--- | :--- | :--- | :--- |
| 客数渗透率 | custPenetrationRate | 0.2646 (26.46%) | 3 |
| 客数 | custNum | 595.41 | 1 |
| 19点前客数 | bf19CustNum | 465.22 | 1 |
| 19点前PI值 | bf19CategoryStoreCustRate | 1.0 (100%) | 3 |

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator bf19MemberRepurchaseRate
```

返回最近约 30 天的逐日19点前复购率数据（current）和同比对照数据（compare）。可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

### 趋势数据特征（基于 2026-04-25 ~ 2026-05-24 30日数据）

- 趋势值范围：0 ~ 0.667（即 0% ~ 66.7%）
- 近期峰值：2026-05-15 达到 0.6666
- 近6日持续回落：0.5804 -> 0.5378 -> 0.4565 -> 0.3480 -> 0.2322 -> 0
- 末端归零：2026-05-24 current=0，compare=0.557，这是单日快照正常现象
- 同比（compare）值在近期大部分日期介于 0.55 ~ 0.63 之间

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator bf19MemberRepurchaseRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的19点前复购率排名（含同比、环比）。

### 区域数据特征（基于 2026-05-24 全国数据）

| 区域 | 代码 | 当前值 | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- |
| 粤西 | CN01 | 0 (0%) | -13.35pp | -43.46pp |
| 粤东 | CN18 | 0 (0%) | -13.70pp | -44.14pp |
| 运营直管 | CN07 | 0 (0%) | 0 | 0 |
| 华东 | CN15 | 0 (0%) | -12.56pp | -41.74pp |

所有区域单日值均为0，但环比和同比（基于滚动7天计算）显示不同程度的下降。运营直管区域环比和同比均为0。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator bf19MemberRepurchaseRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类19点前复购率排名（含同比、环比）。

### 品类数据特征（基于 2026-05-24 全品类数据）

| 品类 | 代码 | 当前值 | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- |
| 预制菜 | 25 | 0 (0%) | -4.70pp | -22.95pp |
| 猪肉 | 13 | 0 (0%) | -12.42pp | -42.92pp |
| 肉禽蛋 | 24 | 0 (0%) | -6.71pp | -29.07pp |
| 水果 | 12 | 0 (0%) | -9.12pp | -32.72pp |
| 水产 | 11 | 0 (0%) | -5.25pp | -24.62pp |
| 蔬菜 | 10 | 0 (0%) | -20.35pp | -57.60pp |
| 冷藏加工 | 26 | 0 (0%) | -8.08pp | -35.21pp |

所有品类单日值均为0。蔬菜品类环比和同比降幅最大。预制菜环比降幅最小。

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
  - `大分类` -> `categoryLevel1Id`（如 12 水果、13 猪肉、10 蔬菜、11 水产）
  - `中分类` -> `categoryLevel2Id`
  - `小分类` -> `categoryLevel3Id`
  - `商品` -> `articleId`

### 6.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

> 19点前复购率无阈值配置，`--display-mode thresholdRatio` 返回 `threshold: null`。

---

## 七、完整示例

### 示例 1：默认查询（全国、全品类、昨天、含同比环比）

```bash
qdm-cmr-cli report business indicators \
  --indicator bf19MemberRepurchaseRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤东区域 + 水产品类 + 全量数据

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator bf19MemberRepurchaseRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 11 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator bf19MemberRepurchaseRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 11

# 区域表现（在粤东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator bf19MemberRepurchaseRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 11

# 品类表现（在水产范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator bf19MemberRepurchaseRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --category-type 大分类 --category 11
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator bf19MemberRepurchaseRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator bf19MemberRepurchaseRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 3** 表示小数形式的比率，需要 x100 转为百分比。例如 `value: 0` 表示 0%。
2. **同比/环比 unit: 3** 表示百分点变化（小数形式）。如 `mom.value: -0.2322` 表示环比下降 23.22 个百分点；`yoy.value: -0.6107` 表示同比下降 61.07 个百分点。
3. **单日值为 0**：滚动7天复购率在单日快照中为 0 是正常现象，不代表业务异常。必须在报告中按 CLI 事实描述，不得推断为会员流失或系统问题。
4. **复购率无阈值配置**，CLI 返回 `threshold: null`，模板中不展示阈值列。
5. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
6. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。如 `status: "up"` 且 `value: -0.2322`，表示箭头指向上（数据层面），但实际值为负。
7. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
8. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
9. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
10. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。
11. 19点前复购率是叶子指标（无子指标），`report business tree` 不会展示更深的子节点。
12. 同一次 `report business indicators` 调用会返回全量指标（含父级链路指标），可在 items 数组中按 indicatorCode 筛选提取。