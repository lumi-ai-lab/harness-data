# 宣传促销费额指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取宣传促销费额（`companyPromotionFee`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。本指标为公司报表（/report/4）费控维度指标，是 `companyPromotionFeeRate` 的金额子指标。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyPromotionFee --full
```

返回字段：`indicatorsName`（宣传促销费额）、`businessDefinition`（null）、`statisticalLogic`（次日达电商营销费+到家电商营销费+其他宣传促销费）。

**真实返回示例（2026-05-24）**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": null,
    "indicatorsCodeEn": "companyPromotionFee",
    "indicatorsName": "宣传促销费额",
    "id": "1980915654158880988",
    "statisticalLogic": "次日达电商营销费+到家电商营销费+其他宣传促销费"
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator companyPromotionFee --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **无品类维度**：公司报表不支持品类过滤，禁止传入 `--category-type` 或 `--category`。

### 返回数据结构

`report company indicators` 返回公司报表全部指标值。`valueUnit: 2` 表示金额型指标，单位为万。

从趋势数据中获取当前值（2026-05-24）：**当前值约 0.32 万**，去年同期为 28.98 万，同比大幅下降 98.9%。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyPromotionFee
```

返回最近约 30 天的逐日宣传促销费额数据（current）和同比对照数据（compare），单位为万：

**真实返回数据（2026-05-24，近30天）**：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/04/25", "current": 29.41, "compare": 34.42, "unit": "万" },
    { "period": "2026/04/26", "current": 23.70, "compare": 26.37, "unit": "万" },
    { "period": "2026/04/27", "current": 59.59, "compare": 18.73, "unit": "万" },
    { "period": "2026/04/28", "current": 49.11, "compare": 26.79, "unit": "万" },
    { "period": "2026/04/29", "current": 94.20, "compare": 38.12, "unit": "万" },
    { "period": "2026/04/30", "current": -7.51, "compare": 51.80, "unit": "万" },
    { "period": "2026/05/01", "current": 22.23, "compare": 19.19, "unit": "万" },
    { "period": "2026/05/02", "current": 16.86, "compare": 16.18, "unit": "万" },
    { "period": "2026/05/03", "current": 12.60, "compare": 17.39, "unit": "万" },
    { "period": "2026/05/04", "current": 11.95, "compare": 17.97, "unit": "万" },
    { "period": "2026/05/05", "current": 56.46, "compare": 20.47, "unit": "万" },
    { "period": "2026/05/06", "current": 17.96, "compare": 59.78, "unit": "万" },
    { "period": "2026/05/07", "current": -107.02, "compare": 19.70, "unit": "万" },
    { "period": "2026/05/08", "current": 22.57, "compare": 14.34, "unit": "万" },
    { "period": "2026/05/09", "current": 21.89, "compare": 14.98, "unit": "万" },
    { "period": "2026/05/10", "current": 30.67, "compare": 23.35, "unit": "万" },
    { "period": "2026/05/11", "current": 173.70, "compare": 22.76, "unit": "万" },
    { "period": "2026/05/12", "current": 43.67, "compare": 52.18, "unit": "万" },
    { "period": "2026/05/13", "current": 38.71, "compare": 53.56, "unit": "万" },
    { "period": "2026/05/14", "current": 20.31, "compare": 19.32, "unit": "万" },
    { "period": "2026/05/15", "current": 19.26, "compare": 50.98, "unit": "万" },
    { "period": "2026/05/16", "current": 31.09, "compare": 27.98, "unit": "万" },
    { "period": "2026/05/17", "current": 28.47, "compare": 25.22, "unit": "万" },
    { "period": "2026/05/18", "current": 49.62, "compare": 22.29, "unit": "万" },
    { "period": "2026/05/19", "current": 35.20, "compare": 28.03, "unit": "万" },
    { "period": "2026/05/20", "current": 24.10, "compare": 19.71, "unit": "万" },
    { "period": "2026/05/21", "current": 87.22, "compare": 15.02, "unit": "万" },
    { "period": "2026/05/22", "current": 59.68, "compare": 24.41, "unit": "万" },
    { "period": "2026/05/23", "current": 0.80, "compare": 22.50, "unit": "万" },
    { "period": "2026/05/24", "current": 0.32, "compare": 28.98, "unit": "万" }
  ]
}
```

可使用 `--week YYYY-NN` 获取周度趋势，`--month YYYY-MM` 获取月度趋势。

### 趋势分析要点

- **近 30 天区间**（基于 CLI 2026-05-24 真实数据）：最低 -107.02 万（05/07，负值表示费用冲回），最高 173.70 万（05/11）。
- **当前值趋势位置**：05/24 为 0.32 万，处于近 30 天极低位，连续两日大幅下降（05/23 为 0.80 万，05/22 为 59.68 万）。
- **与去年同期对比**：05/24 当前值 0.32 万远低于去年同期 28.98 万，降幅约 98.9%。
- valueUnit: 2（金额型），单位：万。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyPromotionFee
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
  --indicator companyPromotionFee \
  --display-mode yoyMom
```

### 示例 2：查询趋势

```bash
qdm-cmr-cli report company trend \
  --indicator companyPromotionFee
```

### 示例 3：月度汇总 + 指定区域

```bash
qdm-cmr-cli report company indicators \
  --indicator companyPromotionFee \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report company overview \
  --indicator companyPromotionFee \
  --month 2026-05
```

---

## 七、注意事项

1. **valueUnit: 2** 表示金额型指标，单位为万。例如 `value: 0.32` 表示宣传促销费额为 0.32 万元（约 3,200 元）。
2. **负值可能**：费用额可能出现负值（如 2026-05-07 的 -107.02 万），表示当天费用冲回或其他特殊调整。
3. **金额子指标**：本指标是 `companyPromotionFeeRate` 的 subIndicator，不可脱离父指标单独作为主维度指标。
4. **统计逻辑**：宣传促销费额 = 次日达电商营销费 + 到家电商营销费 + 其他宣传促销费。
5. **无品类维度**：公司报表不支持品类过滤。
6. **时间粒度限制**：公司报表仅支持周、月；不支持日维度。
7. **区域可选**：未指定区域时按全国口径执行。
8. **命令前缀**：所有命令使用 `qdm-cmr-cli report company`（非 `report business`）。
9. 所有数据均来自 `qdm-cmr-cli report company`，报告 `/report/4` 对应公司/财务报表页面。