# 品牌管理&加盟费指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取品牌管理&加盟费（`manageFranchiseFee`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code manageFranchiseFee --full
```

返回字段：`indicatorsName`（管理&加盟费）、`businessDefinition`（品牌使用费+加盟费收入）、`statisticalLogic`（品牌使用费+加盟费收入）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator manageFranchiseFee --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。

### 返回数据结构

公司报表的 `indicators` 子命令返回全量指标面板数据。从 `items` 数组中筛选 `indicatorCode: "manageFranchiseFee"` 即可获取该指标：

```json
{
  "indicatorCode": "manageFranchiseFee",
  "indicatorName": "管理&加盟费",
  "value": "<value>",
  "valueUnit": 2,
  "zhCNUnit": "万",
  "mom": {
    "value": "<mom_value>",
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": "<yoy_value>",
    "status": "up",
    "unit": 2
  }
}
```

> 注：以上为示例结构，实际值以 CLI 实时返回为准。该指标由品牌使用费和加盟费收入两部分加总构成。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator manageFranchiseFee
```

返回最近约 30 天的逐日数据（current）和同比对照数据（compare）。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator manageFranchiseFee
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的品牌管理&加盟费排名。

> 注意：品牌管理&加盟费是公司级收入指标，区域层面分组数据以实际返回为准。

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
  --indicator manageFranchiseFee \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域

```bash
qdm-cmr-cli report company indicators \
  --indicator manageFranchiseFee \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 3：月度汇总

```bash
qdm-cmr-cli report company indicators \
  --indicator manageFranchiseFee \
  --month 2026-05 \
  --display-mode yoyMom
```

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
3. 公司报表无品类过滤参数（不含 `--category-type` 和 `--category`）。
4. 公司报表的 `indicators` 子命令返回全量指标面板，需从 `items` 数组中按 `indicatorCode: "manageFranchiseFee"` 筛选。
5. 品牌管理&加盟费为叶子指标，无下钻子指标。该指标由"品牌使用费"和"加盟费收入"两部分构成。
6. 所有数据均来自 `qdm-cmr-cli report company`，报告 `/report/4` 对应公司报表页面。
7. `overview` 子命令也可用：`qdm-cmr-cli report company overview --indicator manageFranchiseFee`。