# 客数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取客数（`custNum`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code custNum --full
```

**真实返回示例**（2026-05-25 执行）：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "每天消费的顾客订单数",
    "indicatorBiz": "销售经营",
    "indicatorsCodeEn": "custNum",
    "indicatorsName": "来客数",
    "id": "1877291253581123586",
    "statisticalLogic": "按销售小票ID统计的订单数（物料大分类订单数为0）"
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator custNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 真实返回数据（2026-05-24，全国，全品类）

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeId": "manageAreaId",
    "storeTypeName": "管理区域",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "custNum",
    "indicatorName": "客数"
  },
  "items": [
    {
      "indicatorCode": "custNum",
      "indicatorName": "客数",
      "value": 595.4100456621004,
      "valueUnit": 1,
      "threshold": null,
      "mom": {
        "value": 0.0049,
        "status": "up",
        "arrowStatus": "up",
        "unit": 2
      },
      "yoy": {
        "value": -0.0081,
        "status": "up",
        "arrowStatus": "up",
        "unit": 2
      }
    }
  ]
}
```

**valueUnit = 1 的含义**：整数值（如客数、门店数）。`value: 595.41` 为店日均客数。

**同比/环比 unit = 2 的含义**：比率变化。如 `mom.value: 0.0049` 表示环比上升 0.49%；`yoy.value: -0.0081` 表示同比下降 0.81%。

**同比/环比中的 status**：`status: "up"` 且 `value: -0.0081` 表示箭头向上但数值为负（即同比下降 0.81%）。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 0.0049 表示 +0.49%，-0.0081 表示 -0.81%）
- `unit: 3` — 小数形式的比率变化（如 0.0007 表示 +0.07 个百分点）

**客数无阈值配置**：CLI 返回 `threshold: null`，报告模板中不展示阈值列。

---

## 三、获取趋势分析数据

### 基础命令

```bash
qdm-cmr-cli report business trend --indicator custNum
```

返回最近约 30 天的逐日客数数据（current）和同比对照数据（compare）。

### 真实趋势数据（2026/04/25 - 2026/05/24，共 30 天）

| 周期 | 当前值 | 同比对照 | 波动态势 |
| :--- | :--- | :--- | :--- |
| 2026/04/25 | 606.24 | 525.89 | 周期起始高位 |
| 2026/05/01 | 508.95 | 488.01 | 五一假期回落 |
| 2026/05/02 | 476.32 | 443.50 | 周期内最低点 |
| 2026/05/10 | 587.89 | 564.37 | 周六回升 |
| 2026/05/16 | 601.90 | 523.85 | 周六高峰 |
| 2026/05/20 | 506.33 | 534.53 | 周中回落 |
| 2026/05/24 | 595.41 | 601.87 | 当前值 |

30 天范围：476.32 ~ 606.24，周期内波动明显，周末（周五/周六）为客数高峰，周中为低谷。

### 月度/周度趋势

```bash
# 月度趋势
qdm-cmr-cli report business trend --indicator custNum --month 2026-05

# 周度趋势
qdm-cmr-cli report business trend --indicator custNum --week 2026-21
```

---

## 四、获取区域表现数据

### 基础命令

```bash
qdm-cmr-cli report business area --indicator custNum
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的客数排名（含同比、环比）。

### 真实区域数据（2026-05-24，管理区域，按 current 降序）

| 排名 | 区域 | code | 当前值 | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 运营直管 | CN07 | 760.83 | -3.16% | +27.80% |
| 2 | 华东 | CN15 | 624.57 | -5.21% | -9.29% |
| 3 | 粤东 | CN18 | 619.10 | +1.68% | -1.07% |
| 4 | 粤西 | CN01 | 569.29 | +0.78% | +1.24% |

运营直管客数绝对领先（760.83），但环比下降 3.16%。华东排名第二但同环比均下降。粤东环比逆势上升 1.68%。

---

## 五、获取品类表现数据

### 基础命令

```bash
qdm-cmr-cli report business category --indicator custNum
```

默认按**大分类**维度分组，返回全品类客数排名（含同比、环比）。

### 真实品类数据（2026-05-24，大分类，按 current 降序，前 7）

| 排名 | 品类 | code | 当前值 | 环比 | 同比 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 蔬菜 | 10 | 419.60 | +1.61% | -0.05% |
| 2 | 猪肉 | 13 | 164.10 | -1.35% | -1.77% |
| 3 | 冷藏加工 | 26 | 140.88 | -2.71% | +2.80% |
| 4 | 水果 | 12 | 119.01 | +7.28% | +1.82% |
| 5 | 肉禽蛋 | 24 | 85.61 | +4.53% | +2.38% |
| 6 | 水产 | 11 | 53.05 | -15.40% | +1.66% |
| 7 | 预制菜 | 25 | 42.30 | -9.03% | -2.55% |

蔬菜为最大品类（419.60，占总量约 70%），水果环比大幅上升 7.28%。水产环比大幅下降 15.40%，需关注。

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
  - `大分类` -> 如 10 蔬菜、12 水果、13 猪肉、11 水产、24 肉禽蛋、25 预制菜、26 冷藏加工

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
  --indicator custNum \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 蔬菜品类 + 全量数据

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator custNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 10 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator custNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 10

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator custNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 10

# 品类表现（在蔬菜范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator custNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 10
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator custNum \
  --month 2026-05 \
  --area-type 管理区域 --area CN07 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator custNum \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **valueUnit: 1** 表示整数值，直接使用，无需转换。`value: 595.41` 为店日均客数。
2. **同比/环比 unit: 2** 表示比率变化。如 `mom.value: 0.0049` 表示环比上升 0.49%；`yoy.value: -0.0081` 表示同比下降 0.81%。
3. **客数无阈值配置**，CLI 返回 `threshold: null`，模板中不展示阈值列。
4. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（up/down）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.0081` 表示箭头向上但同比数值为负。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（indicators/area/category/trend/overview）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。
10. 趋势数据默认返回日度数据，使用 `--month` 切换为月度趋势，`--week` 切换为周度趋势。
11. 客数属于用户渗透维度（第三章），禁止放入品效（第四章）或供应链（第五章）章节。