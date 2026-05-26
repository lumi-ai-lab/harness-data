# 流失期用户数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli report user` 获取流失期用户数（`churnedMemberNum`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code churnedMemberNum --full
```

返回字段：`indicatorsName`（流失期会员数）、`businessDefinition`（过去90天中没有消费，但历史至今有过消费的会员数）、`statisticalLogic`（过去90天消费次数=0次且21年至过去91天消费次数>=1的会员id去重计数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator churnedMemberNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **注意**：用户报表不支持品类过滤（无 `--category-type` / `--category` 参数）。

### 返回数据结构

```json
{
  "indicatorCode": "churnedMemberNum",
  "indicatorName": "流失期用户数",
  "value": 1737.15,
  "valueUnit": 1,
  "zhCNUnit": "万",
  "mom": {
    "value": -0.0005,
    "status": "down",
    "unit": 2
  },
  "yoy": {
    "value": -0.0078,
    "status": "down",
    "unit": 2
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如 1737.15 万即 17,371,500 人）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1478 表示 14.78%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 `-0.0005` 表示 -0.05%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator churnedMemberNum
```

返回最近约 30 天的逐日数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/04/25", "current": 1750.9887, "compare": 1470.7216, "unit": "万" },
    { "period": "2026/04/26", "current": 1750.21, "compare": 1469.6347, "unit": "万" },
    { "period": "2026/04/27", "current": 1751.2084, "compare": 1468.8544, "unit": "万" },
    { "period": "2026/04/28", "current": 1751.6041, "compare": 1467.205, "unit": "万" },
    { "period": "2026/04/29", "current": 1752.2205, "compare": 1464.8778, "unit": "万" },
    { "period": "2026/04/30", "current": 1752.5906, "compare": 1462.7386, "unit": "万" },
    { "period": "2026/05/01", "current": 1752.9092, "compare": 1460.1549, "unit": "万" },
    { "period": "2026/05/02", "current": 1753.4133, "compare": 1457.863, "unit": "万" },
    { "period": "2026/05/03", "current": 1753.399, "compare": 1455.6325, "unit": "万" },
    { "period": "2026/05/04", "current": 1753.7589, "compare": 1453.3775, "unit": "万" },
    { "period": "2026/05/05", "current": 1753.2287, "compare": 1452.8934, "unit": "万" },
    { "period": "2026/05/06", "current": 1753.4806, "compare": 1453.0289, "unit": "万" },
    { "period": "2026/05/07", "current": 1753.7836, "compare": 1453.4802, "unit": "万" },
    { "period": "2026/05/08", "current": 1754.6755, "compare": 1454.1079, "unit": "万" },
    { "period": "2026/05/09", "current": 1755.3621, "compare": 1454.9459, "unit": "万" },
    { "period": "2026/05/10", "current": 1754.4093, "compare": 1455.3292, "unit": "万" },
    { "period": "2026/05/11", "current": 1755.0595, "compare": 1454.9583, "unit": "万" },
    { "period": "2026/05/12", "current": 1755.092, "compare": 1455.9322, "unit": "万" },
    { "period": "2026/05/13", "current": 1755.3741, "compare": 1456.4772, "unit": "万" },
    { "period": "2026/05/14", "current": 1755.477, "compare": 1456.9671, "unit": "万" },
    { "period": "2026/05/15", "current": 1755.3386, "compare": 1457.3851, "unit": "万" },
    { "period": "2026/05/16", "current": 1753.6019, "compare": 1458.5102, "unit": "万" },
    { "period": "2026/05/17", "current": 1750.7579, "compare": 1458.7806, "unit": "万" },
    { "period": "2026/05/18", "current": 1748.4901, "compare": 1458.2777, "unit": "万" },
    { "period": "2026/05/19", "current": 1746.067, "compare": 1459.0174, "unit": "万" },
    { "period": "2026/05/20", "current": 1744.2936, "compare": 1459.2931, "unit": "万" },
    { "period": "2026/05/21", "current": 1742.5107, "compare": 1459.7106, "unit": "万" },
    { "period": "2026/05/22", "current": 1740.6108, "compare": 1460.2426, "unit": "万" },
    { "period": "2026/05/23", "current": 1737.9695, "compare": 1461.581, "unit": "万" },
    { "period": "2026/05/24", "current": 1737.1498, "compare": 1461.8931, "unit": "万" }
  ]
}
```

> 近30天趋势范围：2026/04/25 ~ 2026/05/24。当前值呈明显下降趋势，从4月底的约1755万逐步回落至5月24日的1737.15万，近一周（05/18-05/24）持续递减。同比对比（compare）远低于当前值（约1460万 vs 1740万），说明今年流失用户规模大幅高于去年同期。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator churnedMemberNum
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的流失期用户数排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 504.4101,
      "yoy": { "value": -0.008594823333326812, "unit": null },
      "mom": { "value": -0.00031274284392647414, "unit": null },
      "unit": "万"
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 364.0595,
      "yoy": { "value": -0.009829103764373492, "unit": null },
      "mom": { "value": -0.0005249131985195382, "unit": null },
      "unit": "万"
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 210.5415,
      "yoy": { "value": -0.005395316406183564, "unit": null },
      "mom": { "value": -0.0004619281917670911, "unit": null },
      "unit": "万"
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 2.8395,
      "yoy": { "value": -0.008069587088660622, "unit": null },
      "mom": { "value": -0.0016173833550156243, "unit": null },
      "unit": "万"
    }
  ]
}
```

> 排序按 current 降序。粤西（504.41万）流失用户最多，占全国总量的29%。粤东同比降幅最大（-0.98%），华东降幅最小（-0.54%）。所有区域同比和环比均为负增长，说明流失规模在缩小但同比去年仍有较大差距。

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

### 5.3 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

> **注意**：用户报表不支持品类过滤，不要使用 `--category-type` 和 `--category` 参数。

---

## 六、完整示例

### 示例 1：默认查询（全国、昨天、含同比环比）

```bash
qdm-cmr-cli report user indicators \
  --indicator churnedMemberNum \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤东区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report user indicators \
  --indicator churnedMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report user trend \
  --indicator churnedMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18

# 区域表现
qdm-cmr-cli report user area \
  --indicator churnedMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18
```

### 示例 3：月度汇总 + 华东区域维度

```bash
qdm-cmr-cli report user indicators \
  --indicator churnedMemberNum \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator churnedMemberNum \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 三类数据，适合报告生成场景。

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "down"` 且 `value: -0.0078` 表示箭头向下且数值为 -0.78%（即同比减少 0.78%，流失减少是正面信号但箭头向下）。
3. 流失期用户数 `threshold` 为 null，无预设阈值。
4. 流失期用户数 `valueUnit: 1`，值为整数（如 1737.15 万），需结合 `zhCNUnit: "万"` 理解量级。同比环比 unit 为 2（比率变化）。
5. 流失期用户数为叶子指标，无下钻子指标。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 用户报表不支持品类过滤，与经营分析报表（`report business`）不同。
8. 区域过滤条件在所有子命令（`indicators`/`area`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户报表页面。