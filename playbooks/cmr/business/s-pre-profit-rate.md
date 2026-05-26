# 预期毛利率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取预期毛利率（`preProfitRate`）指标的值、趋势、区域表现和品类表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code preProfitRate --full
```

返回字段：`indicatorsName`（门店预期销售毛利率，简称预期毛利率）、`businessDefinition`（门店商品预期销售毛利额占原价销售额的比例）、`statisticalLogic`（门店预期销售毛利额/原价销售额）、`indicatorBiz`（销售经营）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report business indicators --indicator preProfitRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **默认品类**：全品类（不限 `--category-type` 和 `--category`）。

### 返回数据结构（当前指标）

```json
{
  "indicatorCode": "preProfitRate",
  "indicatorName": "预期毛利率",
  "value": 0.4097272749880382,
  "valueUnit": 3,
  "mom": {
    "value": 0.0034,
    "arrowStatus": "up",
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.0048,
    "arrowStatus": "up",
    "status": "up",
    "unit": 3
  },
  "threshold": {
    "compareSymbol": "BETWEEN",
    "compareValue1": 33.5,
    "compareValue2": 35.5,
    "compareValueType": 2
  }
}
```

### 同次调用返回的链路指标

同一 `indicators --display-mode yoyMom` 调用也会返回父级链路相关指标：

**品效 (brandProductEffectiveness)**：
```json
{
  "value": 65.68939849343849,
  "valueUnit": 2,
  "mom": { "value": -0.039, "status": "up", "unit": 2 },
  "yoy": { "value": 0.3356, "status": "up", "unit": 2 },
  "threshold": { "compareSymbol": "GE", "compareValue1": 42, "compareValueType": 2 }
}
```

**定价毛利率 (prePriceProfitRate)**：
```json
{
  "value": 0.3637012693915711,
  "valueUnit": 3,
  "mom": { "value": -0.0012, "status": "up", "unit": 3 },
  "yoy": { "value": -0.0046, "status": "up", "unit": 3 },
  "threshold": { "compareSymbol": "BETWEEN", "compareValue1": 30, "compareValue2": 32, "compareValueType": 2 }
}
```

**出库折让率 (scmPromotionTotalRate)**：
```json
{
  "value": 0.04291752884265983,
  "valueUnit": 3,
  "mom": { "value": 0.0054, "arrowStatus": "down", "status": "down", "unit": 3 },
  "yoy": { "value": -0.0011, "arrowStatus": "down", "status": "down", "unit": 3 },
  "threshold": { "compareSymbol": "LE", "compareValue1": 3.5, "compareValueType": 2 }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` -- 整数值（如客数、门店数）
- `valueUnit: 2` -- 百分比/比率/金额（直接用值，如品效 65.69）
- `valueUnit: 3` -- 小数形式的比率（需 x100 转为百分比，如 0.4097 表示 40.97%）

预期毛利率的 `valueUnit` 为 3，即返回值为小数比率，显示时需乘以 100 转为百分比。示例中 `value: 0.4097` 表示预期毛利率为 **40.97%**。

**同比/环比的 value**：
- `unit: 1` -- 绝对变化量
- `unit: 2` -- 比率变化（如 `-0.039` 表示 -3.9%）
- `unit: 3` -- 小数形式的比率变化（百分点）。如 `mom.value: 0.0034` 表示环比变动 **+0.34 个百分点**；`yoy.value: -0.0048` 表示同比变动 **-0.48 个百分点**。

**阈值说明**：
- 预期毛利率的阈值为 `BETWEEN 33.5-35.5`（`compareValueType: 2` 表示百分比值），即期望预期毛利率保持在 33.5%-35.5% 的区间内。
- 当前值 40.97% 高于阈值区间上限 35.5%，属于预期毛利偏高状态，需关注是否存在过高定价风险。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report business trend --indicator preProfitRate
```

返回最近约 30 天的逐日预期毛利率数据（current）和同比对照数据（compare）：

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
      "current": 0.40972727498803824,
      "compare": 0.367365115493707
    },
    {
      "period": "2026/05/23",
      "current": 0.4063172682797153,
      "compare": 0.35294036349459673
    },
    {
      "period": "2026/05/22",
      "current": 0.4063553951753875,
      "compare": 0.35992345204097237
    },
    {
      "period": "2026/05/21",
      "current": 0.404774711123744,
      "compare": 0.3512101088587592
    },
    {
      "period": "2026/05/20",
      "current": 0.3999364984380748,
      "compare": 0.35501599859029354
    },
    {
      "period": "2026/05/19",
      "current": 0.4059844980325736,
      "compare": 0.35662893365186304
    },
    {
      "period": "2026/05/18",
      "current": 0.4024568533898513,
      "compare": 0.3620485103253155
    },
    {
      "period": "2026/05/17",
      "current": 0.4144978720605237,
      "compare": 0.3675418090582041
    },
    {
      "period": "2026/05/16",
      "current": 0.40868107757713545,
      "compare": 0.3576976971467476
    },
    {
      "period": "2026/05/15",
      "current": 0.40545095564457134,
      "compare": 0.35878974597887353
    },
    {
      "period": "2026/05/14",
      "current": 0.40092003366232526,
      "compare": 0.3461648047906294
    },
    {
      "period": "2026/05/13",
      "current": 0.40015425321326303,
      "compare": 0.35603345227589067
    },
    {
      "period": "2026/05/12",
      "current": 0.4045685231213944,
      "compare": 0.35223399495044155
    },
    {
      "period": "2026/05/11",
      "current": 0.3970237956562156,
      "compare": 0.363835184963459
    },
    {
      "period": "2026/05/10",
      "current": 0.40540354683245894,
      "compare": 0.36722141146151227
    },
    {
      "period": "2026/05/09",
      "current": 0.4024593340631967,
      "compare": 0.35533653367478546
    },
    {
      "period": "2026/05/08",
      "current": 0.39717341349001023,
      "compare": 0.35967027666616747
    },
    {
      "period": "2026/05/07",
      "current": 0.3961814861923726,
      "compare": 0.35423667524887853
    },
    {
      "period": "2026/05/06",
      "current": 0.3995037955267213,
      "compare": 0.35880762769346053
    },
    {
      "period": "2026/05/05",
      "current": 0.3966815001568713,
      "compare": 0.3627003811686534
    },
    {
      "period": "2026/05/04",
      "current": 0.3889890723236724,
      "compare": 0.3603920813889707
    },
    {
      "period": "2026/05/03",
      "current": 0.39666021776640686,
      "compare": 0.35859049801618353
    },
    {
      "period": "2026/05/02",
      "current": 0.39569854220960354,
      "compare": 0.35559373797160737
    },
    {
      "period": "2026/05/01",
      "current": 0.39455316635832877,
      "compare": 0.36137335349156763
    },
    {
      "period": "2026/04/30",
      "current": 0.4055289026935431,
      "compare": 0.3534564787154199
    },
    {
      "period": "2026/04/29",
      "current": 0.4065643228107284,
      "compare": 0.3596941871677142
    },
    {
      "period": "2026/04/28",
      "current": 0.4092213899361658,
      "compare": 0.35828084532103355
    },
    {
      "period": "2026/04/27",
      "current": 0.40345324941214683,
      "compare": 0.3628746977624766
    },
    {
      "period": "2026/04/26",
      "current": 0.41059560306117715,
      "compare": 0.36911171121991654
    },
    {
      "period": "2026/04/25",
      "current": 0.41050465518962953,
      "compare": 0.3563318384583987
    }
  ]
}
```

特点：近期预期毛利率在 0.38899-0.41450 区间波动，整体呈震荡上行走势。5月4日出现近30天最低点（0.38899），5月17日出现近30天最高点（0.41450）。同比对照数据（compare）显示当前一年每一天均高于去年同期水平。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report business area --indicator preProfitRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的预期毛利率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.4878680226419943,
      "yoy": { "value": -0.0007059392779506513, "status": "up", "unit": 3 },
      "mom": { "value": 0.0009020979560998565, "status": "up", "unit": 3 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.4077367820566163,
      "yoy": { "value": -0.010290588796711575, "status": "up", "unit": 3 },
      "mom": { "value": 0.013762011880971647, "status": "up", "unit": 3 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0.40269765732876234,
      "yoy": { "value": -0.002575397758986797, "status": "up", "unit": 3 },
      "mom": { "value": -0.0018804803025192496, "status": "up", "unit": 3 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0.38690745472687715,
      "yoy": { "value": -0.004389626674758951, "status": "up", "unit": 3 },
      "mom": { "value": 0.008894320180322768, "status": "up", "unit": 3 }
    }
  ]
}
```

区域预期毛利率排名：华东（48.79%）> 粤西（40.77%）> 粤东（40.27%）> 运营直管（38.69%）。阈值对所有区域统一为 BETWEEN 33.5-35.5。所有区域均高于阈值上限。

---

## 五、获取品类表现数据

```bash
qdm-cmr-cli report business category --indicator preProfitRate
```

默认按**大分类**（`categoryLevel1Id`）维度分组，返回全品类预期毛利率排名（含同比、环比）：

```json
{
  "grouping": "categoryId",
  "rows": [
    {
      "code": "13",
      "name": "猪肉",
      "current": 0.523861954822724,
      "yoy": { "value": 0.00491466244001959, "unit": 3 },
      "mom": { "value": -0.0010067466507102107, "unit": 3 }
    },
    {
      "code": "26",
      "name": "冷藏加工",
      "current": 0.4105004238703574,
      "yoy": { "value": 0.0033773459951206286, "unit": 3 },
      "mom": { "value": -0.0005351707749705059, "unit": 3 }
    },
    {
      "code": "10",
      "name": "蔬菜",
      "current": 0.40780712316516643,
      "yoy": { "value": -0.012364828501747693, "unit": 3 },
      "mom": { "value": 0.002918065323123553, "unit": 3 }
    },
    {
      "code": "25",
      "name": "预制菜",
      "current": 0.3645698012094103,
      "yoy": { "value": -0.01359442153896212, "unit": 3 },
      "mom": { "value": 0.0008660596650628127, "unit": 3 }
    },
    {
      "code": "11",
      "name": "水产",
      "current": 0.361986970531233,
      "yoy": { "value": -0.0012362757627979448, "unit": 3 },
      "mom": { "value": -0.018319193055940042, "unit": 3 }
    },
    {
      "code": "12",
      "name": "水果",
      "current": 0.35835278480315785,
      "yoy": { "value": -0.012699017124891354, "unit": 3 },
      "mom": { "value": 0.0015297759657209586, "unit": 3 }
    },
    {
      "code": "24",
      "name": "肉禽蛋",
      "current": 0.35535965115787005,
      "yoy": { "value": 0.004696397661357599, "unit": 3 },
      "mom": { "value": 0.015343049215913729, "unit": 3 }
    }
  ]
}
```

品类预期毛利率排名：猪肉（52.39%）> 冷藏加工（41.05%）> 蔬菜（40.78%）> 预制菜（36.46%）> 水产（36.20%）> 水果（35.83%）> 肉禽蛋（35.54%）。仅肉禽蛋（35.54%）落入阈值区间（33.5-35.5），其余品类均高于上限。

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
| `--category` | 对应类型的 ID 或名称 | `--category 00` / `--category 猪肉` | 具体品类 |

- `--category-type` 和 `--category` 必须**成对使用**，不能只传一个。
- **默认**：不限品类（全品类），不传 `--category-type` 和 `--category`。
- 常见 `--category-type` 映射：
  - `大分类` -> `categoryLevel1Id`（如 13 猪肉、26 冷藏加工、10 蔬菜、25 预制菜、11 水产、12 水果、24 肉禽蛋）
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
  --indicator preProfitRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 猪肉品类 + 趋势

```bash
# 指标值
qdm-cmr-cli report business indicators \
  --indicator preProfitRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report business trend \
  --indicator preProfitRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --category-type 大分类 --category 13
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report business indicators \
  --indicator preProfitRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report business overview \
  --indicator preProfitRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`category`、`trend` 四类数据，适合报告生成场景。

---

## 八、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 预期毛利率的 `valueUnit` 为 3（小数比率），显示时需乘以 100 转为百分比。例如 `value: 0.4097` 应显示为 **40.97%**。
3. 同比/环比中的 `unit: 3` 表示小数比率变化（百分点）。例如 `mom.value: 0.0034` 表示环比上升 0.34 个百分点。
4. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
5. 阈值为 `BETWEEN 33.5-35.5`，当前值 40.97% 高于阈值区间上限，属于预期毛利偏高状态，需结合出库折让率分析实际毛利转化效果。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 如果指定了 `--category-type` 但未指定 `--category`（或反之），CLI 会报错。
8. 区域和品类过滤条件在所有子命令（`indicators`/`area`/`category`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report business`，报告 `/report/2` 对应经营分析页面。
10. 预期毛利率为价格利润链路指标，`overview` 命令获取的子指标数据含 `scmPromotionTotalRate`（出库折让率），用于下游影响分析。