# 其他费用额指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取其他费用额（`companyOtherFee`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyOtherFee --full
```

返回字段：`indicatorsName`（其他费用额）、`businessDefinition`（除物流、租金、人员费用、宣传促销费、补贴费之外的其他费用）、`statisticalLogic`（null）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator companyOtherFee --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **公司报表无品类维度**，不传入 `--category-type` 或 `--category`。

### 返回数据结构

`indicators` 子命令返回公司报表全部指标值列表。其中其他费用额的典型结构：

```json
{
  "indicatorCode": "companyOtherFee",
  "indicatorName": "额",
  "value": 28960.86250249247,
  "valueUnit": 2,
  "mom": {
    "value": -0.932,
    "status": "down",
    "unit": 2
  },
  "yoy": {
    "value": -0.9432,
    "status": "down",
    "unit": 2
  },
  "threshold": null,
  "zhCNUnit": ""
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` -- 整数值
- `valueUnit: 2` -- 金额数值（如 28960.86）
- `valueUnit: 3` -- 小数形式的比率（需乘100转为百分比）

**同比/环比的 unit**：
- `unit: 1` -- 绝对变化量
- `unit: 2` -- 比率变化（如 yoy: -0.9432 表示 -94.32%）
- `unit: 3` -- 小数形式的比率变化

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyOtherFee
```

返回最近 30 天的逐日其他费用额数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/05/24", "current": 2.896086250249247, "compare": 22.227433989462998, "unit": "万" },
    { "period": "2026/05/23", "current": 42.574218489230915, "compare": 40.408135252791396, "unit": "万" },
    { "period": "2026/05/22", "current": 81.87829563360502, "compare": 27.1530198138698, "unit": "万" },
    { "period": "2026/05/21", "current": 90.96865004069512, "compare": 79.3999876718557, "unit": "万" },
    { "period": "2026/05/20", "current": 78.38107495933734, "compare": 15.428182338322399, "unit": "万" },
    { "period": "2026/05/19", "current": 55.145760632772465, "compare": 27.448369861644, "unit": "万" },
    { "period": "2026/05/18", "current": 82.90336439324535, "compare": 17.3499776987566, "unit": "万" },
    { "period": "2026/05/17", "current": 51.01730971464092, "compare": 16.8982158186477, "unit": "万" },
    { "period": "2026/05/16", "current": 54.59896338709033, "compare": 32.1698305354969, "unit": "万" },
    { "period": "2026/05/15", "current": 62.68335701394746, "compare": 27.1554122112029, "unit": "万" }
  ]
}
```

- 近 30 天范围：2026/04/25 - 2026/05/24。
- 当前值约 2.90 万（5/24），极度低下，大幅低于前几日（42-91万）。
- 4/30 出现异常峰值 678.64 万，4/28和4/29出现负值（-34.11万、-31.48万），剧烈波动。
- 5月数据在 42-91 万区间波动，5/24 突降至 2.90 万，疑似数据未完全到账。
- 同比对照值范围约 5.60 - 29.35 万（排除4/28-30异常），多数日期 current 高于 compare。
- 可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyOtherFee
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的其他费用额排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01", "name": "粤西",
      "current": 4477.0990000000165,
      "mom": { "value": -0.9671, "status": "down", "unit": 2 },
      "yoy": { "value": -0.9728, "status": "down", "unit": 2 }
    },
    {
      "code": "CN18", "name": "粤东",
      "current": 3922.65333333335,
      "mom": { "value": -0.9702, "status": "down", "unit": 2 },
      "yoy": { "value": -0.9710, "status": "down", "unit": 2 }
    },
    {
      "code": "CN15", "name": "华东",
      "current": 1084.6353032393818,
      "mom": { "value": -0.9721, "status": "down", "unit": 2 },
      "yoy": { "value": -0.9817, "status": "down", "unit": 2 }
    },
    {
      "code": "CN07", "name": "运营直管",
      "current": 0,
      "mom": { "value": null, "status": "down", "unit": 2 },
      "yoy": { "value": null, "status": "down", "unit": 2 }
    }
  ],
  "sort": { "field": "current", "order": "DESC" }
}
```

- **领先区域**：粤西（4477.10）、粤东（3922.65），其他费用额最高。
- **华东**（1084.64），其他费用额低于粤西和粤东，约为粤西的 24%。
- **运营直管**（0），无其他费用数据。
- 同环比全面大幅下降（yoY 约 -97% ~ -98%），需结合趋势判断是否为数据异常。

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
  --indicator companyOtherFee \
  --display-mode yoyMom
```

### 示例 2：指定周 + 华东区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report company indicators \
  --indicator companyOtherFee \
  --week 2026-21 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report company trend \
  --indicator companyOtherFee \
  --week 2026-21 \
  --area-type 管理区域 --area CN15

# 区域表现
qdm-cmr-cli report company area \
  --indicator companyOtherFee \
  --week 2026-21 \
  --area-type 管理区域 --area CN15
```

### 示例 3：月度汇总 + 区域排名

```bash
qdm-cmr-cli report company indicators \
  --indicator companyOtherFee \
  --month 2026-05 \
  --display-mode yoyMom

qdm-cmr-cli report company area \
  --indicator companyOtherFee \
  --month 2026-05 \
  --display-mode yoyMom
```

### 示例 4：查看关联费率父指标

```bash
# 其他费用率指标值
qdm-cmr-cli report company indicators \
  --indicator companyOtherFeeRate \
  --month 2026-05 \
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
7. 其他费用额是其他费用率（`companyOtherFeeRate`）的金额子指标，可通过调用 `companyOtherFeeRate` 查看其他费用的百分比表现。
8. 趋势数据显示 4/28-4/30 期间有异常极值（负值和超大正值），使用该时间段数据时需注意核实。