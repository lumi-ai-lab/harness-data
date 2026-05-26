# 活跃供应商数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取活跃供应商数（`activeVenderNum`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code activeVenderNum --full
```

返回字段：`indicatorsName`（活跃供应商数）、`businessDefinition`（统计周期内，有入库金额的去重供应商数量）、`statisticalLogic`（入库金额＞0的去重供应商数）、`indicatorBiz`（采购环节）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator activeVenderNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构

```json
{
  "indicatorCode": "activeVenderNum",
  "indicatorName": "活跃供应商数",
  "value": 563,               // 当前值（活跃供应商数）
  "valueUnit": 1,             // 单位类型（1=整数值）
  "mom": {
    "value": -0.0175,         // 环比变动（-1.75%）
    "status": "up",           // 箭头方向
    "unit": 2
  },
  "yoy": {
    "value": 0,               // 同比变动（0%）
    "status": "up",
    "unit": 2
  },
  "threshold": null           // 无阈值配置
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如供应商数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1478 表示 14.78%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量（如 `+0.25` 分）
- `unit: 2` — 比率变化（如 `-0.0175` 表示 -1.75%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator activeVenderNum
```

返回最近约 30 天的逐日活跃供应商数数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 563,           // 当前周期值
      "compare": 562            // 同比对照值（去年同期）
    },
    {
      "period": "2026/05/23",
      "current": 573,
      "compare": 562
    },
    {
      "period": "2026/05/22",
      "current": 575,
      "compare": 553
    },
    {
      "period": "2026/05/21",
      "current": 571,
      "compare": 563
    },
    {
      "period": "2026/05/20",
      "current": 576,
      "compare": 553
    },
    {
      "period": "2026/05/19",
      "current": 567,
      "compare": 554
    },
    {
      "period": "2026/05/18",
      "current": 567,
      "compare": 553
    },
    {
      "period": "2026/05/17",
      "current": 563,
      "compare": 570
    },
    {
      "period": "2026/05/16",
      "current": 576,
      "compare": 556
    },
    {
      "period": "2026/05/15",
      "current": 580,
      "compare": 563
    }
  ]
}
```

> 近30天趋势范围：2026/04/25 ~ 2026/05/24。当前值范围 545~583，同比对照值范围 544~570。峰值出现在 2026/05/14（current=583），近一周（05/18-05/24）在 563~576 区间波动。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator activeVenderNum
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的活跃供应商数排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 182,
      "yoy": { "value": 0.0055248618784530384 },
      "mom": { "value": -0.061855670103092786 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 170,
      "yoy": { "value": 0.017964071856287425 },
      "mom": { "value": -0.005847953216374269 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 77,
      "yoy": { "value": -0.01282051282051282 },
      "mom": { "value": -0.07228915662650602 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": null,
      "yoy": { "value": null },
      "mom": { "value": null }
    }
  ]
}
```

> 排序按 current 降序。粤西（182）和粤东（170）贡献了主要供应商资源。运营直管区域数据为 null。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator activeVenderNum
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类活跃供应商数排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 157,
      "yoy": { "value": -0.024844720496894408 },
      "mom": { "value": 0.00641025641025641 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 124,
      "yoy": { "value": 0 },
      "mom": { "value": -0.015873015873015872 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 81,
      "yoy": { "value": -0.024096385542168676 },
      "mom": { "value": -0.03571428571428571 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 72,
      "yoy": { "value": -0.04 },
      "mom": { "value": -0.04 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 61,
      "yoy": { "value": 0.03389830508474576 },
      "mom": { "value": 0 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 55,
      "yoy": { "value": 0.018518518518518517 },
      "mom": { "value": 0.018518518518518517 }
    },
    {
      "code": "13",
      "name": "猪肉",
      "current": 38,
      "yoy": { "value": -0.07317073170731707 },
      "mom": { "value": 0 }
    }
  ]
}
```

> 排序按 current 降序。冷藏加工（157）和蔬菜（124）品类供应商最多。猪肉（38）供应商最少且同比降幅最大（-7.32%）。

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
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 粤西` | 具体区域 |

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
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 蔬菜` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` → `categoryLevel1Id`（如 26 冷藏加工、10 蔬菜、24 肉禽蛋、12 水果、11 水产、13 猪肉）
  - `中分类` → `categoryLevel2Id`（如 1124 两栖类）
  - `小分类` → `categoryLevel3Id`
  - `商品` → `articleId`
- 品类过滤与下钻：当指定大分类后，`area` 和 `category` 子命令会在此品类范围内进一步下钻。例如 `--category-type 大分类 --category 10` 时，`category` 子命令会显示该大分类下各中分类的活跃供应商数表现。

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
  --indicator activeVenderNum \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域 + 蔬菜品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator activeVenderNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator activeVenderNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10

# 区域表现（在粤西范围内按督导下钻）
qdm-cmr-cli report business area \
  --indicator activeVenderNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10

# 品类表现（在蔬菜范围内按中分类下钻）
qdm-cmr-cli report business category \
  --indicator activeVenderNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --category-type 大分类 --category 10
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator activeVenderNum \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator activeVenderNum \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.0175` 表示箭头向上但数值为 -1.75%（即环比下降）。
3. 活跃供应商数 `threshold` 为 null，无预设阈值。
4. 活跃供应商数 `valueUnit: 1`，值为整数（如 563），同比环比 unit 为 2（比率变化）。
5. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
6. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
7. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
8. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。