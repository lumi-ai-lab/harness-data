# 宣传促销补贴费额指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取宣传促销补贴费额（`companyPromotionAllowanceFee`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。本指标为公司报表（/report/4）费控维度指标，是 `companyPromotionAllowanceFeeRate` 的金额子指标。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyPromotionAllowanceFee --full
```

返回字段：`indicatorsName`（宣传促销补贴费额）、`businessDefinition`（用于支持门店经营及门店营销的费用额）、`statisticalLogic`（宣传促销费用额+补贴费用额）。

**真实返回示例（2026-05-24）**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "用于支持门店经营及门店营销的费用额",
    "indicatorsCodeEn": "companyPromotionAllowanceFee",
    "indicatorsName": "宣传促销补贴费额",
    "id": "1980915654158880986",
    "statisticalLogic": "宣传促销费用额+补贴费用额"
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator companyPromotionAllowanceFee --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **无品类维度**：公司报表不支持品类过滤，禁止传入 `--category-type` 或 `--category`。

### 返回数据结构

`report company indicators` 返回公司报表全部指标值。`valueUnit: 2` 表示金额型指标，单位为万。

从趋势数据中获取当前值（2026-05-24）：**当前值约 0.32 万**，去年同期为 45.67 万，同比大幅下降 99.3%。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyPromotionAllowanceFee
```

返回最近约 30 天的逐日宣传促销补贴费额数据（current）和同比对照数据（compare），单位为万：

**真实返回数据（2026-05-24，近30天）**：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/04/25", "current": 51.04, "compare": 46.69, "unit": "万" },
    { "period": "2026/04/26", "current": 40.15, "compare": 38.07, "unit": "万" },
    { "period": "2026/04/27", "current": 72.53, "compare": 28.70, "unit": "万" },
    { "period": "2026/04/28", "current": 79.74, "compare": 44.77, "unit": "万" },
    { "period": "2026/04/29", "current": 128.41, "compare": 59.07, "unit": "万" },
    { "period": "2026/04/30", "current": 21.01, "compare": 67.72, "unit": "万" },
    { "period": "2026/05/01", "current": 48.39, "compare": 29.47, "unit": "万" },
    { "period": "2026/05/02", "current": 35.58, "compare": 25.15, "unit": "万" },
    { "period": "2026/05/03", "current": 28.17, "compare": 25.43, "unit": "万" },
    { "period": "2026/05/04", "current": 31.50, "compare": 24.22, "unit": "万" },
    { "period": "2026/05/05", "current": 65.99, "compare": 26.42, "unit": "万" },
    { "period": "2026/05/06", "current": 24.08, "compare": 64.73, "unit": "万" },
    { "period": "2026/05/07", "current": -88.43, "compare": 43.07, "unit": "万" },
    { "period": "2026/05/08", "current": 33.21, "compare": 20.41, "unit": "万" },
    { "period": "2026/05/09", "current": 33.83, "compare": 22.30, "unit": "万" },
    { "period": "2026/05/10", "current": 47.35, "compare": 34.83, "unit": "万" },
    { "period": "2026/05/11", "current": 202.72, "compare": 33.36, "unit": "万" },
    { "period": "2026/05/12", "current": 59.49, "compare": 62.18, "unit": "万" },
    { "period": "2026/05/13", "current": 60.21, "compare": 80.23, "unit": "万" },
    { "period": "2026/05/14", "current": 36.71, "compare": 48.95, "unit": "万" },
    { "period": "2026/05/15", "current": 44.51, "compare": 68.32, "unit": "万" },
    { "period": "2026/05/16", "current": 41.81, "compare": 44.98, "unit": "万" },
    { "period": "2026/05/17", "current": 36.64, "compare": 43.05, "unit": "万" },
    { "period": "2026/05/18", "current": 69.44, "compare": 37.52, "unit": "万" },
    { "period": "2026/05/19", "current": 59.01, "compare": 41.49, "unit": "万" },
    { "period": "2026/05/20", "current": 36.62, "compare": 42.98, "unit": "万" },
    { "period": "2026/05/21", "current": 101.75, "compare": 36.66, "unit": "万" },
    { "period": "2026/05/22", "current": 80.62, "compare": 40.78, "unit": "万" },
    { "period": "2026/05/23", "current": 24.48, "compare": 37.87, "unit": "万" },
    { "period": "2026/05/24", "current": 0.32, "compare": 45.67, "unit": "万" }
  ]
}
```

可使用 `--week YYYY-NN` 获取周度趋势，`--month YYYY-MM` 获取月度趋势。

### 趋势分析要点

- **近 30 天区间**（基于 CLI 2026-05-24 真实数据）：最低 -88.43 万（05/07，负值表示费用冲回），最高 202.72 万（05/11）。
- **当前值趋势位置**：05/24 为 0.32 万，处于近 30 天极低位，连续两日大幅下降（05/23 为 24.48 万，05/22 为 80.62 万）。
- **与去年同期对比**：05/24 当前值 0.32 万远低于去年同期 45.67 万，降幅约 99.3%。
- valueUnit: 2（金额型），单位：万。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyPromotionAllowanceFee
```

默认按**管理区域**（`manageAreaId`）维度分组。公司报表中的费用类指标区域维度返回空数据（rows 为空数组）。

```json
{
  "grouping": "storeId",
  "sort": { "field": "current", "order": "DESC" },
  "rows": []
}
```

---

## 五、过滤条件说明

### 5.1 时间过滤

| 参数 | 格式 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--week` | `YYYY-NN` | `--week 2026-21` | 指定周（ISO 周号） |
| `--month` | `YYYY-MM` | `--month 2026-05` | 指定月份 |

> 公司/财务报表只支持周、月时间粒度；禁止使用日维度，禁止对 company 报表传入 `--date`。

### 5.2 区域过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--area-type` | `管理区域` / `督导` / `大区` / `门店` 等 | `--area-type 管理区域` | 区域维度类型 |
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 华东` | 具体区域 |

### 5.3 品类过滤

品类维度不可选，默认全品类；禁止传入 `--category-type` 或 `--category`。

### 5.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |

---

## 六、完整示例

### 示例 1：默认查询（全国、含同比环比）

```bash
qdm-cmr-cli report company indicators \
  --indicator companyPromotionAllowanceFee \
  --display-mode yoyMom
```

### 示例 2：查询趋势

```bash
qdm-cmr-cli report company trend \
  --indicator companyPromotionAllowanceFee
```

### 示例 3：月度汇总 + 指定区域

```bash
qdm-cmr-cli report company indicators \
  --indicator companyPromotionAllowanceFee \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report company overview \
  --indicator companyPromotionAllowanceFee \
  --month 2026-05
```

---

## 七、注意事项

1. **valueUnit: 2** 表示金额型指标，单位为万。例如 `value: 0.32` 表示宣传促销补贴费额为 0.32 万元（约 3,200 元）。
2. **负值可能**：费用额可能出现负值（如 2026-05-07 的 -88.43 万），表示当天费用冲回或其他特殊调整。
3. **金额子指标**：本指标是 `companyPromotionAllowanceFeeRate` 的 subIndicator，不可脱离父指标单独作为主维度指标。
4. **无品类维度**：公司报表不支持品类过滤。
5. **时间粒度限制**：公司报表仅支持周、月；不支持日维度。
6. **区域可选**：未指定区域时按全国口径执行。
7. **命令前缀**：所有命令使用 `qdm-cmr-cli report company`（非 `report business`）。
8. 所有数据均来自 `qdm-cmr-cli report company`，报告 `/report/4` 对应公司/财务报表页面。