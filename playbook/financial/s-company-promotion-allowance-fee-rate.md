# 宣传促销补贴费率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取宣传促销补贴费率（`companyPromotionAllowanceFeeRate`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。本指标为公司报表（/report/4）费控维度指标。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyPromotionAllowanceFeeRate --full
```

返回字段：`indicatorsName`（宣传促销补贴费率）、`businessDefinition`（宣传促销费额占公司收入的占比）、`statisticalLogic`（null）。

**真实返回示例（2026-05-24）**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "宣传促销费额占公司收入的占比",
    "indicatorsCodeEn": "companyPromotionAllowanceFeeRate",
    "indicatorsName": "宣传促销补贴费率",
    "id": "1980915654158880985",
    "statisticalLogic": null
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator companyPromotionAllowanceFeeRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **无品类维度**：公司报表不支持品类过滤，禁止传入 `--category-type` 或 `--category`。

### 返回数据结构

`report company indicators` 返回公司报表全部指标值。`valueUnit: 3` 表示小数形式的比率，需 ×100 转为百分比。

从趋势数据中获取当前值（2026-05-24）：**当前值约 0.01%（0.0001016 小数比率），去年同期约 1.27%（0.01274 小数比率）**，同比大幅下降。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyPromotionAllowanceFeeRate
```

返回最近约 30 天的逐日宣传促销补贴费率数据（current）和同比对照数据（compare），为小数比率形式（valueUnit: 3）：

**真实返回数据（2026-05-24，近30天）**：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/04/25", "current": 0.01410, "compare": 0.01710 },
    { "period": "2026/04/26", "current": 0.01222, "compare": 0.01092 },
    { "period": "2026/04/27", "current": 0.02860, "compare": 0.00978 },
    { "period": "2026/04/28", "current": 0.02923, "compare": 0.01704 },
    { "period": "2026/04/29", "current": 0.05005, "compare": 0.02123 },
    { "period": "2026/04/30", "current": 0.00785, "compare": 0.02497 },
    { "period": "2026/05/01", "current": 0.01614, "compare": 0.01017 },
    { "period": "2026/05/02", "current": 0.01431, "compare": 0.01024 },
    { "period": "2026/05/03", "current": 0.01172, "compare": 0.01018 },
    { "period": "2026/05/04", "current": 0.01301, "compare": 0.00957 },
    { "period": "2026/05/05", "current": 0.02190, "compare": 0.00947 },
    { "period": "2026/05/06", "current": 0.00932, "compare": 0.02434 },
    { "period": "2026/05/07", "current": -0.03327, "compare": 0.01615 },
    { "period": "2026/05/08", "current": 0.01225, "compare": 0.00763 },
    { "period": "2026/05/09", "current": 0.01154, "compare": 0.00837 },
    { "period": "2026/05/10", "current": 0.01290, "compare": 0.00966 },
    { "period": "2026/05/11", "current": 0.07898, "compare": 0.00992 },
    { "period": "2026/05/12", "current": 0.02122, "compare": 0.02400 },
    { "period": "2026/05/13", "current": 0.02314, "compare": 0.02850 },
    { "period": "2026/05/14", "current": 0.01387, "compare": 0.01810 },
    { "period": "2026/05/15", "current": 0.01664, "compare": 0.02508 },
    { "period": "2026/05/16", "current": 0.01230, "compare": 0.01641 },
    { "period": "2026/05/17", "current": 0.01154, "compare": 0.01148 },
    { "period": "2026/05/18", "current": 0.02713, "compare": 0.01114 },
    { "period": "2026/05/19", "current": 0.02093, "compare": 0.01575 },
    { "period": "2026/05/20", "current": 0.01372, "compare": 0.01559 },
    { "period": "2026/05/21", "current": 0.03855, "compare": 0.01410 },
    { "period": "2026/05/22", "current": 0.02980, "compare": 0.01546 },
    { "period": "2026/05/23", "current": 0.00702, "compare": 0.01377 },
    { "period": "2026/05/24", "current": 0.00010, "compare": 0.01274 }
  ]
}
```

可使用 `--week YYYY-NN` 获取周度趋势，`--month YYYY-MM` 获取月度趋势。

### 趋势分析要点

- **近 30 天区间**（基于 CLI 2026-05-24 真实数据）：最低 -0.03327（05/07，负值，对应 -3.33%），最高 0.07898（05/11，对应 7.90%）。
- **当前值趋势位置**：05/24 为 0.010%（0.00010 小数比率），处于近 30 天极低位，较前日 0.70%（05/23）大幅回落。
- **与去年同期对比**：近 30 天中多数日期当前值与去年同期基本持平或略低，05/24 当前值 0.01% 远低于去年同期 1.27%，为近 30 天最低点。
- valueUnit: 3（小数比率），需 ×100 转为百分比。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyPromotionAllowanceFeeRate
```

默认按**管理区域**（`manageAreaId`）维度分组。公司报表中的费用率类指标区域维度返回空数据（rows 为空数组），这是因为费率指标为公司层面的汇总指标，不适合按管理区域拆分。

```json
{
  "grouping": "storeId",
  "sort": { "field": "current", "order": "DESC" },
  "rows": []
}
```

> 如需查看区域维度的费用表现，可使用具体费用分项指标进行区域查询，或使用 `--area-type` 和 `--area` 过滤特定区域。

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

- `--area-type` 和 `--area` 必须**成对使用**，不能只传一个。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。

### 5.3 品类过滤

品类维度不可选，默认全品类；禁止传入 `--category-type` 或 `--category`。

### 5.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

---

## 六、完整示例

### 示例 1：默认查询（全国、含同比环比）

```bash
qdm-cmr-cli report company indicators \
  --indicator companyPromotionAllowanceFeeRate \
  --display-mode yoyMom
```

### 示例 2：查询趋势

```bash
qdm-cmr-cli report company trend \
  --indicator companyPromotionAllowanceFeeRate
```

### 示例 3：月度汇总 + 指定区域

```bash
qdm-cmr-cli report company indicators \
  --indicator companyPromotionAllowanceFeeRate \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report company overview \
  --indicator companyPromotionAllowanceFeeRate \
  --month 2026-05
```

---

## 七、注意事项

1. **valueUnit: 3** 表示小数形式的比率，需要 ×100 转为百分比。例如 `value: 0.00010` 表示宣传促销补贴费率为 0.01%。
2. **同比/环比 unit: 3** 表示百分点变化（小数形式）。
3. **负值可能**：费率可能出现负值（如 2026-05-07 的 -0.03327 对应 -3.33%），表示当天费用冲回或其他特殊调整。
4. **无品类维度**：公司报表不支持品类过滤。
5. **时间粒度限制**：公司报表仅支持周、月；不支持日维度。
6. **区域可选**：未指定区域时按全国口径执行；费率类汇总指标按区域查询可能返回空数据。
7. **命令前缀**：所有命令使用 `qdm-cmr-cli report company`（非 `report business`）。
8. **金额子指标**：可通过 `companyPromotionAllowanceFee` 查询对应的金额数据。
9. **子指标**：本指标有两个子指标（宣传促销费率 `companyPromotionFeeRate`、补贴费用率 `companyAllowanceFeeRate`），可分别查询。
10. 所有数据均来自 `qdm-cmr-cli report company`，报告 `/report/4` 对应公司/财务报表页面。