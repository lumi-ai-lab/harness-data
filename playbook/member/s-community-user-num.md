# 社群用户数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取社群用户数（`communityUserNum`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。用户报表使用 `report user` 子命令。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code communityUserNum --full
```

返回字段：`indicatorsName`（社群用户数）、`businessDefinition`（企业微信社群中的用户数量）、`statisticalLogic`（企业微信社群中的用户id去重计数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator communityUserNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **用户报表不支持品类过滤**，不传 `--category-type` 和 `--category`。

### 返回数据结构

```json
{
  "indicatorCode": "communityUserNum",
  "indicatorName": "社群用户数",
  "value": 103.66,
  "valueUnit": 1,
  "zhCNUnit": "万",
  "mom": {
    "value": 0.0022,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.012,
    "status": "up",
    "unit": 2
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如用户数，注意 `zhCNUnit` 可能为"万"）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比，如 0.1478 表示 14.78%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量（如 `+0.25`）
- `unit: 2` — 比率变化（如 `0.0022` 表示 +0.22%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator communityUserNum
```

返回最近约 30 天的逐日社群用户数数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/04/25",
      "current": 102.6524,
      "compare": 68.6118,
      "unit": "万"
    },
    {
      "period": "2026/04/26",
      "current": 102.7357,
      "compare": 68.658,
      "unit": "万"
    },
    {
      "period": "2026/04/27",
      "current": 102.6385,
      "compare": 68.7025,
      "unit": "万"
    },
    {
      "period": "2026/04/28",
      "current": 102.6957,
      "compare": 68.7473,
      "unit": "万"
    },
    {
      "period": "2026/04/29",
      "current": 102.6981,
      "compare": 68.8138,
      "unit": "万"
    },
    {
      "period": "2026/05/19",
      "current": 102.602,
      "compare": 70.0522,
      "unit": "万"
    },
    {
      "period": "2026/05/20",
      "current": 102.8175,
      "compare": 70.1348,
      "unit": "万"
    },
    {
      "period": "2026/05/21",
      "current": 103.0563,
      "compare": 70.2093,
      "unit": "万"
    },
    {
      "period": "2026/05/22",
      "current": 103.3051,
      "compare": 70.2724,
      "unit": "万"
    },
    {
      "period": "2026/05/23",
      "current": 103.4372,
      "compare": 70.3361,
      "unit": "万"
    },
    {
      "period": "2026/05/24",
      "current": 103.6626,
      "compare": 70.3888,
      "unit": "万"
    }
  ]
}
```

> 近30天趋势范围：2026/04/25 ~ 2026/05/24。当前值范围 102.14万~103.66万，同比对照值范围 68.61万~70.39万。低点出现在 2026/05/04（current=102.14万），高点出现在 2026/05/24（current=103.66万）。05/18 后连续 7 天持续回升。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator communityUserNum
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的社群用户数排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 396801,
      "mom": { "value": 0.0012010345045101874 },
      "yoy": { "value": 0.00927883037901275 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 281744,
      "mom": { "value": 0.0010837161871666684 },
      "yoy": { "value": 0.009603531806323997 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 64568,
      "mom": { "value": 0.0009146010634175076 },
      "yoy": { "value": 0.013037952837441361 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 4834,
      "mom": { "value": 0.0012427506213753107 },
      "yoy": { "value": 0.14441287878787878 }
    }
  ]
}
```

> 排序按 current 降序。粤西（396,801）和粤东（281,744）贡献了绝大部分社群用户。运营直管（4,834）体量最小但同比增速最高（+14.44%）。

---

## 五、过滤条件说明

### 5.1 时间过滤

| 参数 | 格式 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--date` | `YYYY-MM-DD` | `--date 2026-05-24` | 指定日期（默认：昨天） |
| `--week` | `YYYY-NN` | `--week 2026-21` | 指定周（ISO 周号） |
| `--month` | `YYYY-MM` | `--month 2026-05` | 指定月份 |

> 三个时间参数互斥，只能使用其中一个。**默认**：不传任何时间参数时，取昨天日期。

### 5.2 区域过滤

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

### 5.3 品类过滤

**用户报表不支持品类过滤**。不要传递 `--category-type` 或 `--category` 参数。所有数据默认全品类口径。

### 5.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

---

## 六、完整示例

### 示例 1：默认查询（全国、昨天、含同比环比）

```bash
qdm-cmr-cli report user indicators \
  --indicator communityUserNum \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report user indicators \
  --indicator communityUserNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report user trend \
  --indicator communityUserNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01

# 区域表现（在粤西范围内按督导下钻）
qdm-cmr-cli report user area \
  --indicator communityUserNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report user indicators \
  --indicator communityUserNum \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator communityUserNum \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 数据，适合报告生成场景。用户报表 overview 不返回 category 数据。

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: 0.0022` 表示箭头向上、数值 +0.22%（即环比上升）。
3. 社群用户数 `threshold` 为 null，无预设阈值。
4. 社群用户数 `valueUnit: 1`，值为整数（如 103.66），注意 `zhCNUnit` 为"万"，实际值为 103.66 万。同比环比 unit 为 2（比率变化）。
5. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
6. 用户报表**不支持品类过滤**，不要传递 `--category-type` 或 `--category` 参数。
7. 区域过滤条件在所有子命令（`indicators`/`area`/`trend`/`overview`）中通用。
8. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户运营分析页面。
9. 社群用户数是叶子指标，无下级子指标，不支持下钻分析。
10. 父指标为可触达用户数（`reachMemberNum`），计算渗透率时使用社群用户数 / 可触达用户数。