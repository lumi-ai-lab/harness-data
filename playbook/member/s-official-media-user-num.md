# 官媒用户数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取官媒用户数（`officialMediaUserNum`）指标的详情、趋势数据，以及如何添加过滤条件。用户报表使用 `report user` 子命令。
>
> **重要提示**：当前 `indicators` 子命令不返回该指标值，但 `trend` 子命令可返回完整的趋势数据。该指标仅在 CLI 返回有值时展示。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code officialMediaUserNum --full
```

返回字段：`indicatorsName`（官媒用户数）、`businessDefinition`（统计周期内，最后一天的微信公众号"不卖隔夜肉"的粉丝数量）、`statisticalLogic`（微信公众号"不卖隔夜肉"的粉丝数量）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator officialMediaUserNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **用户报表不支持品类过滤**，不传 `--category-type` 和 `--category`。

### 返回说明

当前 `indicators` 子命令不返回该指标值（该指标在 items 数组中不出现）。此时应从 `trend` 子命令获取最新数据：

```bash
qdm-cmr-cli report user trend --indicator officialMediaUserNum
```

从趋势数据中提取最后一日的 `current` 值作为当前指标值。

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如用户数，注意 `zhCNUnit` 可能为"万"）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比，如 0.1478 表示 14.78%）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator officialMediaUserNum
```

返回最近约 30 天的逐日官媒用户数数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    {
      "period": "2026/04/25",
      "current": 327.9644,
      "compare": 320.4189,
      "unit": "万"
    },
    {
      "period": "2026/04/26",
      "current": 327.9838,
      "compare": 320.4415,
      "unit": "万"
    },
    {
      "period": "2026/04/27",
      "current": 327.9986,
      "compare": 320.4628,
      "unit": "万"
    },
    {
      "period": "2026/04/28",
      "current": 328.0828,
      "compare": 320.4813,
      "unit": "万"
    },
    {
      "period": "2026/04/29",
      "current": 328.1164,
      "compare": 320.5349,
      "unit": "万"
    },
    {
      "period": "2026/05/19",
      "current": 328.59,
      "compare": 321.0652,
      "unit": "万"
    },
    {
      "period": "2026/05/20",
      "current": 328.5998,
      "compare": 321.1197,
      "unit": "万"
    },
    {
      "period": "2026/05/21",
      "current": 328.6113,
      "compare": 321.1433,
      "unit": "万"
    },
    {
      "period": "2026/05/22",
      "current": 328.6274,
      "compare": 321.1667,
      "unit": "万"
    },
    {
      "period": "2026/05/23",
      "current": 328.6425,
      "compare": 321.1871,
      "unit": "万"
    },
    {
      "period": "2026/05/24",
      "current": 328.6572,
      "compare": 321.2116,
      "unit": "万"
    }
  ]
}
```

> 近30天趋势范围：2026/04/25 ~ 2026/05/24。当前值范围 327.96万~328.66万，同比对照值范围 320.42万~321.21万。呈稳定缓慢增长态势，日均增长约 240 人。05/24 当前值 328.66 万为近 30 天峰值。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator officialMediaUserNum
```

当前返回空数据：

```json
{
  "grouping": "storeId",
  "rows": []
}
```

官媒用户数暂不支持按区域下钻。

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
- 当前区域下钻返回空数据，区域过滤效果有限。

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

### 示例 1：默认查询（全国、昨天）

```bash
# 指标值（当前不返回该指标数据）
qdm-cmr-cli report user indicators \
  --indicator officialMediaUserNum \
  --display-mode yoyMom

# 趋势（主要数据来源）
qdm-cmr-cli report user trend \
  --indicator officialMediaUserNum
```

### 示例 2：指定日期 + 趋势

```bash
qdm-cmr-cli report user trend \
  --indicator officialMediaUserNum \
  --date 2026-05-24
```

### 示例 3：月度趋势汇总

```bash
qdm-cmr-cli report user trend \
  --indicator officialMediaUserNum \
  --month 2026-05
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator officialMediaUserNum \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 数据。注意 `indicators` 和 `area` 当前可能为空。

---

## 七、注意事项

1. 当前 `indicators` 子命令不返回官媒用户数指标值，主要数据来源为 `trend` 子命令。
2. 从趋势数据获取当前值时，取最后一日的 `current` 值；同比计算参考同日的 `compare` 值；环比计算参考前一日的 `current` 值。
3. 官媒用户数 `threshold` 为 null，无预设阈值。
4. 官媒用户数 `valueUnit: 1`，值为数字（如 328.6572），注意 `unit` 为"万"，实际值为 328.66 万。
5. `area` 子命令当前返回空数据（rows: []），区域下钻暂不可用。
6. 用户报表**不支持品类过滤**，不要传递 `--category-type` 或 `--category` 参数。
7. 该指标仅在 CLI 返回有值时展示；如果 trend 也返回空数据，报告应省略此指标。
8. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户运营分析页面。
9. 官媒用户数是叶子指标，无下级子指标，不支持下钻分析。
10. 父指标为可触达用户数（`reachMemberNum`），计算渗透率时使用官媒用户数 / 可触达用户数。