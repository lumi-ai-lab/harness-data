# 用户挽回率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli report user` 获取用户挽回率（`winbackMemberRate`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。
>
> **重要**：用户挽回率仅在 CLI 返回有值时展示。当前（2026-05-24）CLI 返回的指标值均为 0，区域表现无数据，实际使用中需以 CLI 实际返回为准。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code winbackMemberRate --full
```

返回字段：`indicatorsName`（用户挽回率）、`businessDefinition`（上月是休眠期然后在本月重新产生了消费的用户数占上月是休眠期的用户数）、`statisticalLogic`（上月是休眠期本月重新消费的用户数 / 上月休眠期用户数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator winbackMemberRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **注意**：用户报表不支持品类过滤（无 `--category-type` / `--category` 参数）。
- **注意**：用户挽回率可能不返回有效值，此时 items 列表中不会包含该指标。

### 返回数据结构（有值时）

```json
{
  "indicatorCode": "winbackMemberRate",
  "indicatorName": "用户挽回率",
  "value": "<实际值>",
  "valueUnit": 3,
  "mom": {
    "value": "<环比变动>",
    "status": "<up/down>",
    "unit": 3
  },
  "yoy": {
    "value": "<同比变动>",
    "status": "<up/down>",
    "unit": 3
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如人数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1478 表示 14.78%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator winbackMemberRate
```

返回最近约 30 天的逐日数据（current）和同比对照数据（compare）。

> 当前（2026-05-24）趋势数据中所有值均为 0，说明该指标暂无有效数据。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator winbackMemberRate
```

默认按**管理区域**（`manageAreaId`）维度分组。

> 当前（2026-05-24）区域表现无数据（rows 为空数组），说明该指标暂无区域维度的有效数据。

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
  --indicator winbackMemberRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域

```bash
qdm-cmr-cli report user indicators \
  --indicator winbackMemberRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --display-mode yoyMom
```

### 示例 3：月度汇总 + 全国维度

```bash
qdm-cmr-cli report user indicators \
  --indicator winbackMemberRate \
  --month 2026-05 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator winbackMemberRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 三类数据，适合报告生成场景。

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 用户挽回率 `threshold` 为 null，无预设阈值。
3. 用户挽回率预期 `valueUnit: 3`（小数形式的比率，需 ×100 转为百分比），同比环比 unit 为 3（小数比率变化/百分点）。
4. **用户挽回率仅在 CLI 返回有值时展示**。如果 CLI 返回的指标值为 null 或全为 0，应在报告中省略该指标行和所有相关分析段落。
5. 用户挽回率为叶子指标，无下钻子指标。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 用户报表不支持品类过滤，与经营分析报表（`report business`）不同。
8. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户报表页面。