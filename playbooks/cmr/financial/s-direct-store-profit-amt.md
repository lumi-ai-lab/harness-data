# 直营店毛利额指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取直营店毛利额（`directStoreProfitAmt`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code directStoreProfitAmt --full
```

返回字段：`indicatorsName`（直营店毛利额）、`businessDefinition`（直营店的门店毛利额，如果门店转让了，取统计周期内是直营店身份的时间进行统计）、`statisticalLogic`（销售额-(进货额+门店期初库存金额-门店期末库存金额)）、`indicatorBiz`（销售经营）。

**真实返回示例（2026-05-24）**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "直营店的门店毛利额，如果门店转让了，取统计周期内是直营店身份的时间进行统计",
    "indicatorBiz": "销售经营",
    "indicatorsCodeEn": "directStoreProfitAmt",
    "indicatorsName": "直营店毛利额",
    "id": "2002995668319924226",
    "statisticalLogic": "销售额-(进货额+门店期初库存金额-门店期末库存金额)"
  }
}
```

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report company indicators --indicator directStoreProfitAmt --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **公司报表不支持品类维度**，禁止传入 `--category-type` 或 `--category`。

### 返回数据结构

```json
{
  "indicatorCode": "directStoreProfitAmt",
  "indicatorName": "直营店毛利额",
  "value": 0,
  "valueUnit": 2,
  "mom": {
    "value": -1,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": -1,
    "status": "up",
    "unit": 2
  }
}
```

- value: 0，valueUnit: 2，当前日直营店毛利额为 0。
- 环比变动的 value: -1（unit: 2 表示比率变化，-1 即 -100%）。
- 同比变动的 value: -1（-100%）。

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report company trend --indicator directStoreProfitAmt
```

**真实返回示例（2026-05-24）**：

近 30 天直营店毛利额日趋势数据（2026/04/25 ~ 2026/05/24）：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "directStoreProfitAmt",
    "indicatorName": "直营店毛利额"
  },
  "grouping": "ctime",
  "rows": [
    {
      "compare": 72741.43,
      "current": 68662.24,
      "period": "2026/04/25"
    },
    {
      "compare": 97273.07,
      "current": 69184.67,
      "period": "2026/04/26"
    },
    {
      "compare": 71250.78,
      "current": 38143.50,
      "period": "2026/04/27"
    },
    {
      "compare": 40893.13,
      "current": 26156.78,
      "period": "2026/04/28"
    },
    {
      "compare": 48401.82,
      "current": 37229.56,
      "period": "2026/04/29"
    },
    {
      "compare": 55810.96,
      "current": 39721.99,
      "period": "2026/04/30"
    },
    {
      "compare": 54558.39,
      "current": 39341.18,
      "period": "2026/05/01"
    },
    {
      "compare": 25523.43,
      "current": 14389.48,
      "period": "2026/05/02"
    },
    {
      "compare": 42223.08,
      "current": 42453.60,
      "period": "2026/05/03"
    },
    {
      "compare": 63601.05,
      "current": 35535.24,
      "period": "2026/05/04"
    },
    {
      "compare": 66228.19,
      "current": 52264.53,
      "period": "2026/05/05"
    },
    {
      "compare": 58561.40,
      "current": -548.75,
      "period": "2026/05/06"
    },
    {
      "compare": 66006.42,
      "current": 35317.89,
      "period": "2026/05/07"
    },
    {
      "compare": 59513.89,
      "current": 39054.97,
      "period": "2026/05/08"
    },
    {
      "compare": 60973.58,
      "current": 28665.85,
      "period": "2026/05/09"
    },
    {
      "compare": 80030.57,
      "current": 63738.94,
      "period": "2026/05/10"
    },
    {
      "compare": 82866.41,
      "current": 35411.69,
      "period": "2026/05/11"
    },
    {
      "compare": 50165.87,
      "current": 22705.94,
      "period": "2026/05/12"
    },
    {
      "compare": 53697.58,
      "current": 16818.85,
      "period": "2026/05/13"
    },
    {
      "compare": 52910.53,
      "current": 40904.91,
      "period": "2026/05/14"
    },
    {
      "compare": 55766.26,
      "current": 37770.64,
      "period": "2026/05/15"
    },
    {
      "compare": 51303.71,
      "current": 63495.53,
      "period": "2026/05/16"
    },
    {
      "compare": 72992.32,
      "current": 73177.20,
      "period": "2026/05/17"
    },
    {
      "compare": 77210.29,
      "current": 25055.31,
      "period": "2026/05/18"
    },
    {
      "compare": 46663.38,
      "current": 38891.08,
      "period": "2026/05/19"
    },
    {
      "compare": 53315.34,
      "current": 19636.83,
      "period": "2026/05/20"
    },
    {
      "compare": 54103.23,
      "current": 32143.19,
      "period": "2026/05/21"
    },
    {
      "compare": 53881.14,
      "current": 15187.00,
      "period": "2026/05/22"
    },
    {
      "compare": 51486.98,
      "current": 52479.04,
      "period": "2026/05/23"
    },
    {
      "compare": 76424.58,
      "current": 0,
      "period": "2026/05/24"
    }
  ]
}
```

**趋势分析要点**：

近 30 天（2026/04/25 ~ 2026/05/24）直营店毛利额日度波动区间：

- **最高日毛利额**：2026/05/17 当期 73,177.20，同比 72,992.32
- **最低日毛利额**：2026/05/06 当期 -548.75（亏损日）
- **期末日**：2026/05/24 当期 0，同比 76,424.58
- 多数日期毛利额在 15,000 ~ 70,000 区间波动，05/02（14,389.48）、05/06（-548.75）为明显低点。
- 05/06 出现唯一负值日（-548.75），可能与节假日或特殊业务调整有关。
- 05/24 当前值为 0，同比去年同日为 76,424.58，当日可能存在数据延迟。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report company area --indicator directStoreProfitAmt
```

**真实返回示例（2026-05-24）**：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "directStoreProfitAmt",
    "indicatorName": "直营店毛利额"
  },
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0,
      "compare1Value": 9561.39,
      "compare2Value": 9506.00
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 0,
      "compare1Value": 6688.51,
      "compare2Value": 7657.28
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 0,
      "compare1Value": 0,
      "compare2Value": 0
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 0,
      "compare1Value": 6020.90,
      "compare2Value": 9737.62
    }
  ],
  "sort": {
    "field": "current",
    "order": "DESC"
  }
}
```

**区域分析要点**：

- 全体区域当日 current 均为 0，但历史对比值反映区域差异。
- **粤西**：历史 compare1Value/compare2Value 约 9,500 ~ 9,561，为毛利额最高区域。
- **华东**：历史 compare2Value 约 9,738，compare1Value 约 6,021，波动较大。
- **粤东**：历史值 6,689 ~ 7,657，处于中等水平。
- **运营直管**：历史值均为 0，可能该区域无直营店或暂无毛利数据。

---

## 五、过滤条件

- 公司报表只支持周、月时间粒度，禁止使用日维度。
- 禁止对 company 报表传入 `--date`。
- 区域维度可选，用户未指定时不强制追加。
- 品类维度不可选，禁止传入 `--category-type` 或 `--category`。

## 六、完整示例

```bash
# 基础指标值
qdm-cmr-cli report company indicators --indicator directStoreProfitAmt --display-mode yoyMom

# 趋势分析
qdm-cmr-cli report company trend --indicator directStoreProfitAmt

# 区域表现
qdm-cmr-cli report company area --indicator directStoreProfitAmt
```

## 七、注意事项

- 公司报表使用 `report company` 子命令，非 `report business`。
- 直营店毛利额是公司毛利额的子指标（lineType: dashed），叶子指标无下级子指标。
- 统计口径：如果门店转让了，取统计周期内是直营店身份的时间进行统计。
- 统计逻辑：销售额-(进货额+门店期初库存金额-门店期末库存金额)。
- valueUnit: 2 表示数值直接使用（金额单位）。
- 05/24 的 current 为 0、mom 和 yoy 返回 -1，可能为当日数据尚未完全同步，报告时应注明时间口径。