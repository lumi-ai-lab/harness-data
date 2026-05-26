# 公司营业收入指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取公司营业收入（`companyBusinessIncome`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code companyBusinessIncome --full
```

返回字段：`indicatorsName`（公司营业收入）、`businessDefinition`（null）、`statisticalLogic`（-加盟费用收入+供应链收入+直营门店收入+品牌使用费收入-直营门店成本+职能部门收入+（-其他收入-其他支出））。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator companyBusinessIncome --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。

### 返回数据结构

公司报表的 `indicators` 子命令返回全量指标面板数据。从 `items` 数组中筛选 `indicatorCode: "companyBusinessIncome"` 即可获取该指标：

```json
{
  "indicatorCode": "companyBusinessIncome",
  "indicatorName": "公司营业收入",
  "value": 3183.4,
  "valueUnit": 2,
  "zhCNUnit": "万",
  "mom": {
    "value": -0.0878,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.0025,
    "status": "up",
    "unit": 2
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值
- `valueUnit: 2` — 金额/百分比（直接用值，如 3183.4 表示 3,183.4 万）
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比）

**zhCNUnit** 为中文单位（如 "万"），仅在金额类指标中出现。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator companyBusinessIncome
```

返回最近约 30 天的逐日数据（current）和同比对照数据（compare）：

```json
{
  "filters": {
    "periodType": "DATE",
    "indicatorName": "公司营业收入"
  },
  "rows": [
    {
      "period": "2026/05/24",
      "current": 3183.4,
      "compare": 3175.5
    }
  ],
  "report": {
    "id": "4",
    "name": "公司报表",
    "alias": "company"
  }
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator companyBusinessIncome
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的公司营业收入排名：

```json
{
  "filters": {
    "periodType": "DATE",
    "storeTypeId": "manageAreaId",
    "storeTypeName": "管理区域",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "companyBusinessIncome",
    "indicatorName": "公司营业收入"
  },
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 850.3,
      "yoy": { "value": 0.012 },
      "mom": { "value": -0.065 }
    }
  ],
  "report": {
    "id": "4",
    "name": "公司报表",
    "alias": "company"
  }
}
```

> 注意：区域维度数据以实际返回为准。公司营业收入是公司财务汇总指标，部分区域数据可能不适用。

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
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 华东` | 具体区域 |

- `--area-type` 和 `--area` 必须**成对使用**，不能只传一个。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。
- 常见 `--area-type` 映射：
  - `管理区域` -> `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` -> `groupManagerId`
  - `大区` -> `manageRegionId`
  - `门店` -> `storeId`

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
  --indicator companyBusinessIncome \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域

```bash
qdm-cmr-cli report company indicators \
  --indicator companyBusinessIncome \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 3：月度汇总 + 趋势

```bash
# 月度汇总
qdm-cmr-cli report company indicators \
  --indicator companyBusinessIncome \
  --month 2026-05 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report company trend \
  --indicator companyBusinessIncome \
  --month 2026-05
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report company overview \
  --indicator companyBusinessIncome \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 三类数据。

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
3. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
4. 公司报表无品类过滤参数（不含 `--category-type` 和 `--category`）。
5. 公司报表的 `indicators` 子命令返回全量指标面板，需从 `items` 数组中按 `indicatorCode: "companyBusinessIncome"` 筛选。
6. 公司营业收入的子指标包括：`financeScmIncome`（供应链收入）、`directStoreIncome`（直营店收入）、`manageFranchiseFee`（品牌管理&加盟费）、`otherBusinessProfit`（其他业务收支净额）。
7. 所有数据均来自 `qdm-cmr-cli report company`，报告 `/report/4` 对应公司报表页面。