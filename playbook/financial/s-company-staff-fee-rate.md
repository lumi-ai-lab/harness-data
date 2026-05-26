# 人员费用率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取人员费用率（`companyStaffFeeRate`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyStaffFeeRate --full
```

返回字段：`indicatorsName`（人员费用率）、`businessDefinition`（人员费用占公司收入的占比）、`statisticalLogic`（null）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator companyStaffFeeRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **公司报表无品类维度**，不传入 `--category-type` 或 `--category`。

### 返回数据结构

`indicators` 子命令返回公司报表全部指标值列表。其中人员费用率的典型结构：

```json
{
  "indicatorCode": "companyStaffFeeRate",
  "indicatorName": "人员费用率",
  "value": 0.03022532063759062,
  "valueUnit": 3,
  "mom": {
    "value": 0.0027,
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": 0.0027,
    "status": "up",
    "unit": 3
  },
  "threshold": null,
  "zhCNUnit": ""
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` -- 整数值
- `valueUnit: 2` -- 金额/比率数值
- `valueUnit: 3` -- 小数形式的比率（需乘100转为百分比，如 0.0302 表示 3.02%）

**同比/环比的 unit**：
- `unit: 1` -- 绝对变化量
- `unit: 2` -- 比率变化
- `unit: 3` -- 小数形式的比率变化（如 mom: 0.0027 表示 +0.27 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyStaffFeeRate
```

返回最近 30 天的逐日人员费用率数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/05/24", "current": 0.03022532063759062, "compare": 0.02756935353282729, "unit": null },
    { "period": "2026/05/23", "current": 0.02753967691512129, "compare": 0.03595075644531337, "unit": null },
    { "period": "2026/05/22", "current": 0.03555268175737231, "compare": 0.03749833662642406, "unit": null },
    { "period": "2026/05/21", "current": 0.03643131389672752, "compare": 0.038087947342420124, "unit": null },
    { "period": "2026/05/20", "current": 0.03609963673451768, "compare": 0.03597515949652159, "unit": null },
    { "period": "2026/05/19", "current": 0.03402725517966749, "compare": 0.03753152540149113, "unit": null },
    { "period": "2026/05/18", "current": 0.03749426207421719, "compare": 0.029353680305009597, "unit": null },
    { "period": "2026/05/17", "current": 0.030306122585430535, "compare": 0.026387286582943856, "unit": null },
    { "period": "2026/05/16", "current": 0.028294940150491592, "compare": 0.036179882328129305, "unit": null },
    { "period": "2026/05/15", "current": 0.035979600025742874, "compare": 0.03637804117568702, "unit": null }
  ]
}
```

- 近 30 天范围：2026/04/25 - 2026/05/24。
- 当前值 0.0302（3.02%），波动区间约 0.0262（5/10最低） ~ 0.0607（4/30峰值）。
- 4/30 出现异常峰值 0.0607，明显偏离正常水平。
- 可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyStaffFeeRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的人员费用率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [],
  "sort": { "field": "current", "order": "DESC" }
}
```

- 当前日期（2026-05-24）的人员费用率区域数据为空（`rows: []`），说明该指标在当前时间点暂无区域维度下钻数据。
- 如后续有数据返回，区域排名按 `current` 值降序排列。
- 可通过 `--area-type` 切换区域维度（如 `--area-type 大区`）。

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
| `--area-type` | `管理区域` / `大区` / `门店` 等 | `--area-type 管理区域` | 区域维度类型 |
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 华东` | 具体区域 |

- `--area-type` 和 `--area` 必须**成对使用**，不能只传一个。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。

### 5.3 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

---

## 六、完整示例

### 示例 1：默认查询（全国、昨天、含同比环比）

```bash
qdm-cmr-cli report company indicators \
  --indicator companyStaffFeeRate \
  --display-mode yoyMom
```

### 示例 2：指定周 + 华东区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report company indicators \
  --indicator companyStaffFeeRate \
  --week 2026-21 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report company trend \
  --indicator companyStaffFeeRate \
  --week 2026-21 \
  --area-type 管理区域 --area CN15

# 区域表现
qdm-cmr-cli report company area \
  --indicator companyStaffFeeRate \
  --week 2026-21 \
  --area-type 管理区域 --area CN15
```

### 示例 3：月度汇总 + 全国 + 查看人员费用额

```bash
# 人员费用率
qdm-cmr-cli report company indicators \
  --indicator companyStaffFeeRate \
  --month 2026-05 \
  --display-mode yoyMom

# 关联的金额子指标：人员费用额
qdm-cmr-cli report company indicators \
  --indicator companyStaffFee \
  --month 2026-05 \
  --display-mode yoyMom
```

### 示例 4：指定日期（需转为所在周）

```bash
qdm-cmr-cli report company indicators \
  --indicator companyStaffFeeRate \
  --week 2026-21 \
  --display-mode yoyMom
```

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）仅表示箭头方向，不代表数值正负。
3. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
4. 公司报表**不支持品类维度**，禁止传入 `--category-type` 或 `--category`。
5. 公司/财务报表只支持周、月时间粒度；用户询问昨天、今天或具体日期时，必须转换为该日期所在 ISO 周。
6. 所有数据均来自 `qdm-cmr-cli report company`，报告 `/report/4` 对应公司报表页面。
7. 人员费用率关联金额子指标 `companyStaffFee`（人员费用额），可通过独立查询查看人员费用的绝对值。