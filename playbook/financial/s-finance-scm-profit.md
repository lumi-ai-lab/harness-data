# 供应链毛利额(财务)指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取供应链毛利额(财务)（`financeScmProfit`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code financeScmProfit --full
```

返回字段：`indicatorsName`（供应链毛利额(财务)）、`businessDefinition`（供应链毛利额(财务)）、`statisticalLogic`（暂无详细统计逻辑说明）。

**真实返回示例（2026-05-24）**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "供应链毛利额(财务)",
    "indicatorsCodeEn": "financeScmProfit",
    "indicatorsName": "供应链毛利额(财务)",
    "id": "2054518046525100037",
    "statisticalLogic": null
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator financeScmProfit --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **公司报表不支持品类维度**，禁止传入 `--category-type` 或 `--category`。

### 返回数据结构

```json
{
  "indicatorCode": "financeScmProfit",
  "indicatorName": "供应链毛利额",
  "value": 0,
  "valueUnit": 2,
  "mom": {
    "value": null,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": null,
    "status": "up",
    "unit": 2
  }
}
```

- value: 0，valueUnit: 2，当前供应链毛利额数据为 0。
- 环比和同比的变动的 value 均为 null。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator financeScmProfit
```

**真实返回示例（2026-05-24）**：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "financeScmProfit",
    "indicatorName": "供应链毛利额"
  },
  "grouping": "ctime",
  "rows": [
    {
      "compare": 0,
      "current": 0,
      "period": "2026/04/25"
    }
    // ... 近30天数据，所有值均为 0
  ]
}
```

**趋势分析要点**：

- 近 30 天（2026/04/25 ~ 2026/05/24）所有数据点的 current 和 compare 均为 0。
- 供应链毛利额在该统计周期内暂无活跃数据。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator financeScmProfit
```

**真实返回示例（2026-05-24）**：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "financeScmProfit",
    "indicatorName": "供应链毛利额"
  },
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0,
      "compare1Value": 0,
      "compare2Value": 0
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0,
      "compare1Value": 0,
      "compare2Value": 0
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 0,
      "compare1Value": 0,
      "compare2Value": 0
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0,
      "compare1Value": 0,
      "compare2Value": 0
    }
  ],
  "sort": {
    "field": "current",
    "order": "DESC"
  }
}
```

**区域分析要点**：

- 全部 4 个管理区域的 current 值均为 0，无区域间分化。
- 区域包括：粤西（CN01）、粤东（CN18）、华东（CN15）、运营直管（CN07）。

---

## 五、过滤条件

- 公司报表只支持周、月时间粒度，禁止使用日维度。
- 禁止对 company 报表传入 `--date`。
- 区域维度可选，用户未指定时不强制追加。
- 品类维度不可选，禁止传入 `--category-type` 或 `--category`。

## 六、完整示例

```bash
# 基础指标值
qdm-cmr-cli report company indicators --indicator financeScmProfit --display-mode yoyMom

# 趋势分析
qdm-cmr-cli report company trend --indicator financeScmProfit

# 区域表现
qdm-cmr-cli report company area --indicator financeScmProfit
```

## 七、注意事项

- 公司报表使用 `report company` 子命令，非 `report business`。
- 供应链毛利额(财务)是公司毛利额的子指标（lineType: dashed），叶子指标无下级子指标。
- 当前所有数据均为零值（value: 0），属于正常现象。
- valueUnit: 2 表示数值直接使用。
- 环比和同比的 value 为 null 时，应标注为"无数据"而非"0%变化"。