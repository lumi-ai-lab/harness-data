# 总费用额指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取总费用额（`companyTotalFee`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。本指标为公司报表（/report/4）费控维度指标。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyTotalFee --full
```

返回字段：`indicatorsName`（费额）、`businessDefinition`（公司总的费用支出金额）、`statisticalLogic`（宣传促销补贴费额+物流费额+租金费额+人员费额+其他费额）。

**真实返回示例（2026-05-24）**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "公司总的费用支出金额",
    "indicatorsCodeEn": "companyTotalFee",
    "indicatorsName": "费额",
    "id": "1980915654158880983",
    "statisticalLogic": "宣传促销补贴费额+物流费额+租金费额+人员费额+其他费额"
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator companyTotalFee --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **无品类维度**：公司报表不支持品类过滤，禁止传入 `--category-type` 或 `--category`。

### 返回数据结构

`report company indicators` 返回公司报表全部指标值，其中包含当前指标项。`valueUnit: 2` 表示金额型指标，单位为万。

**真实数据（2026-05-24，全国）**：

- 总费用额（companyTotalFee）：从 trend 命令取最近一天：2026-05-24 为 **138.06 万**，去年同期为 259.06 万，同比下降约 46.7%。
- 公司营业收入（companyBusinessIncome）：3183.40 万，环比 -8.78%，同比 +0.25%。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyTotalFee
```

返回最近约 30 天的逐日总费用额数据（current）和同比对照数据（compare），单位为万：

**真实返回数据（2026-05-24，近30天）**：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/04/25", "current": 294.93, "compare": 297.60, "unit": "万" },
    { "period": "2026/04/26", "current": 269.25, "compare": 339.85, "unit": "万" },
    { "period": "2026/04/27", "current": 343.12, "compare": 277.03, "unit": "万" },
    { "period": "2026/04/28", "current": 224.37, "compare": 767.53, "unit": "万" },
    { "period": "2026/04/29", "current": 277.61, "compare": 334.05, "unit": "万" },
    { "period": "2026/04/30", "current": 983.83, "compare": 650.24, "unit": "万" },
    { "period": "2026/05/01", "current": 261.73, "compare": 224.94, "unit": "万" },
    { "period": "2026/05/02", "current": 243.33, "compare": 216.81, "unit": "万" },
    { "period": "2026/05/03", "current": 231.00, "compare": 217.66, "unit": "万" },
    { "period": "2026/05/04", "current": 246.59, "compare": 226.64, "unit": "万" },
    { "period": "2026/05/05", "current": 299.31, "compare": 236.53, "unit": "万" },
    { "period": "2026/05/06", "current": 262.51, "compare": 272.08, "unit": "万" },
    { "period": "2026/05/07", "current": 160.00, "compare": 302.83, "unit": "万" },
    { "period": "2026/05/08", "current": 271.54, "compare": 215.42, "unit": "万" },
    { "period": "2026/05/09", "current": 293.39, "compare": 270.19, "unit": "万" },
    { "period": "2026/05/10", "current": 279.21, "compare": 249.91, "unit": "万" },
    { "period": "2026/05/11", "current": 450.95, "compare": 237.16, "unit": "万" },
    { "period": "2026/05/12", "current": 300.26, "compare": 282.60, "unit": "万" },
    { "period": "2026/05/13", "current": 327.47, "compare": 309.63, "unit": "万" },
    { "period": "2026/05/14", "current": 290.30, "compare": 281.31, "unit": "万" },
    { "period": "2026/05/15", "current": 285.82, "compare": 278.85, "unit": "万" },
    { "period": "2026/05/16", "current": 279.39, "compare": 261.20, "unit": "万" },
    { "period": "2026/05/17", "current": 269.34, "compare": 252.97, "unit": "万" },
    { "period": "2026/05/18", "current": 329.96, "compare": 243.70, "unit": "万" },
    { "period": "2026/05/19", "current": 292.66, "compare": 252.77, "unit": "万" },
    { "period": "2026/05/20", "current": 287.64, "compare": 241.78, "unit": "万" },
    { "period": "2026/05/21", "current": 363.92, "compare": 299.76, "unit": "万" },
    { "period": "2026/05/22", "current": 334.97, "compare": 250.66, "unit": "万" },
    { "period": "2026/05/23", "current": 202.44, "compare": 261.86, "unit": "万" },
    { "period": "2026/05/24", "current": 138.06, "compare": 259.06, "unit": "万" }
  ]
}
```

可使用 `--week YYYY-NN` 获取周度趋势，`--month YYYY-MM` 获取月度趋势。

### 趋势分析要点

- **近 30 天区间**（基于 CLI 2026-05-24 真实数据）：最低 138.06 万（05/24），最高 983.83 万（04/30）。
- **当前值趋势位置**：05/24 为 138.06 万，处于近 30 天低位，连续两日下跌（05/23 为 202.44 万）。
- **与去年同期对比**：近 30 天中多数日期接近或略高于去年同期，但 04/30 显著高于同期（983.83 vs 650.24），而 05/24 明显低于同期（138.06 vs 259.06）。
- valueUnit: 2（金额型），单位：万。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyTotalFee
```

默认按**管理区域**（`manageAreaId`）维度分组。公司报表中的费用类指标区域维度返回空数据（rows 为空数组），这是因为总费用额为公司层面的汇总指标，不适合按管理区域拆分。

```json
{
  "grouping": "storeId",
  "sort": { "field": "current", "order": "DESC" },
  "rows": []
}
```

> 如需查看区域维度的费用表现，可使用具体费用分项指标（如运输费、租金费等）进行区域查询，或使用 `--area-type` 和 `--area` 过滤特定区域。

---

## 五、过滤条件说明

### 5.1 时间过滤

| 参数 | 格式 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--week` | `YYYY-NN` | `--week 2026-21` | 指定周（ISO 周号） |
| `--month` | `YYYY-MM` | `--month 2026-05` | 指定月份 |

> 公司/财务报表只支持周、月时间粒度；禁止使用日维度，禁止对 company 报表传入 `--date`。用户询问昨天、今天或具体日期时，必须转换为该日期所在 ISO 周。

### 5.2 区域过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--area-type` | `管理区域` / `督导` / `大区` / `门店` 等 | `--area-type 管理区域` | 区域维度类型 |
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 华东` | 具体区域 |

- `--area-type` 和 `--area` 必须**成对使用**，不能只传一个。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。
- 区域维度可选；用户未指定区域时不强制追加区域过滤，按 CLI 默认全国口径执行。

### 5.3 品类过滤

品类维度不可选，默认全品类；禁止传入 `--category-type` 或 `--category`。

### 5.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

---

## 六、完整示例

### 示例 1：默认查询（全国、含同比环比）

```bash
qdm-cmr-cli report company indicators \
  --indicator companyTotalFee \
  --display-mode yoyMom
```

### 示例 2：查询趋势

```bash
qdm-cmr-cli report company trend \
  --indicator companyTotalFee
```

### 示例 3：月度汇总 + 指定区域

```bash
qdm-cmr-cli report company indicators \
  --indicator companyTotalFee \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report company overview \
  --indicator companyTotalFee \
  --month 2026-05
```

`overview` 子命令一次性返回指标列表、区域、趋势等数据，适合报告生成场景。

---

## 七、注意事项

1. **valueUnit: 2** 表示金额型指标，单位为万。例如 `value: 138.06` 表示总费用额为 138.06 万元。
2. **同比/环比 unit: 2** 表示比率变化。
3. **无品类维度**：公司报表不支持品类过滤，禁止传入 `--category-type` 或 `--category`。
4. **时间粒度限制**：公司报表仅支持周、月；不支持日维度。用户询问特定日期时需转换为该日期所在 ISO 周。
5. **区域可选**：未指定区域时按全国口径执行；费用类汇总指标按区域查询可能返回空数据。
6. **命令前缀**：所有命令使用 `qdm-cmr-cli report company`（非 `report business`）。
7. 同比（yoy）= 与去年同期对比的变化率；环比（mom）= 与上一个周期对比的变化率。
8. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
9. 所有数据均来自 `qdm-cmr-cli report company`，报告 `/report/4` 对应公司/财务报表页面。