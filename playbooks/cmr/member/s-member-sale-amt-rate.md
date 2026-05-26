# 门店会员销售占比（memberSaleAmtRate）Playbook

## 1. 获取指标详情

```bash
qdm-cmr-cli indicator detail --code memberSaleAmtRate --full
```

返回示例：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "会员销售额占总门店销售额比重",
    "indicatorBiz": "销售经营",
    "indicatorsCodeEn": "memberSaleAmtRate",
    "indicatorsName": "门店会员销售占比",
    "statisticalLogic": "会员销售额/销售额"
  }
}
```

## 2. 获取指标值（含同比环比）

```bash
qdm-cmr-cli report user indicators --indicator memberSaleAmtRate --display-mode yoyMom
```

返回示例（仅贴memberSaleAmtRate核心字段）：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeId": "manageAreaId",
    "storeTypeName": "管理区域",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "memberSaleAmtRate",
    "indicatorName": "会员销售占比",
    "displayMode": "yoyMom"
  },
  "items": [
    {
      "indicatorCode": "memberSaleAmtRate",
      "indicatorName": "会员销售占比",
      "value": 0.6932030033788119,
      "valueUnit": 3,
      "threshold": {
        "compareSymbol": "GE",
        "compareValue1": 60,
        "compareValue2": 60,
        "compareValueType": 2
      },
      "mom": {
        "arrowStatus": "up",
        "status": "up",
        "unit": 3,
        "value": -0.0038
      },
      "yoy": {
        "arrowStatus": "up",
        "status": "up",
        "unit": 3,
        "value": -0.0214
      }
    }
  ]
}
```

**字段说明**:
- `value`: 0.6932...，valueUnit=3表示小数比率，实际为69.32%
- `threshold`: GE 60%，即要求会员销售占比 >= 60%
- `mom.value`: -0.0038，unit=3，即环比下降0.38个百分点
- `yoy.value`: -0.0214，unit=3，即同比下降2.14个百分点

## 3. 获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator memberSaleAmtRate
```

返回示例（截取最近7天）：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)"
  },
  "grouping": "ctime",
  "rows": [
    {"compare": 0.7559171953461519, "current": 0.6897979981560524, "period": "2026/05/22"},
    {"compare": 0.762597222674175,  "current": 0.6970381548333817, "period": "2026/05/23"},
    {"compare": 0.7533931478999014, "current": 0.693203003378812,  "period": "2026/05/24"}
  ]
}
```

**字段说明**: `compare` 为去年同期值，`current` 为当前值。

## 4. 获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator memberSaleAmtRate
```

返回示例：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeId": "manageAreaId",
    "storeTypeName": "管理区域",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)"
  },
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01", "name": "粤西",
      "current": 0.7519214424320603,
      "mom": {"unit": 3, "value": -0.0106},
      "yoy": {"unit": 3, "value": 0.0053}
    },
    {
      "code": "CN07", "name": "运营直管",
      "current": 0.7302528013665246,
      "mom": {"unit": 3, "value": -0.0015},
      "yoy": {"unit": 3, "value": 0.0279}
    },
    {
      "code": "CN18", "name": "粤东",
      "current": 0.7287285716574795,
      "mom": {"unit": 3, "value": -0.0076},
      "yoy": {"unit": 3, "value": 0.0075}
    },
    {
      "code": "CN15", "name": "华东",
      "current": 0.561217159537628,
      "mom": {"unit": 3, "value": 0.0280},
      "yoy": {"unit": 3, "value": 0.0220}
    }
  ],
  "sort": {"field": "current", "order": "DESC"}
}
```

**区域排名**: 粤西(75.19%) > 运营直管(73.03%) > 粤东(72.87%) > 华东(56.12%)
**注意**: 华东未达60%阈值线，需重点关注。

## 5. 过滤条件说明

### 时间过滤

| 参数 | 说明 | 示例 |
|------|------|------|
| `--date` | 指定日期 | `--date 2026-05-24` |
| `--week` | 指定周 | `--week 2026-W21` |
| `--month` | 指定月份 | `--month 2026-05` |

### 区域过滤

| 参数 | 说明 | 可选值 |
|------|------|--------|
| `--area-type` | 区域类型 | manageAreaId（管理区域） |
| `--area` | 区域code | CN00（全国不含港澳）、CN01（粤西）、CN07（运营直管）、CN18（粤东）、CN15（华东） |

**默认值**: 未指定时，`--area-type` 默认 manageAreaId，`--area` 默认 CN00（全国不含港澳）。

### 显示模式

| 参数 | 说明 |
|------|------|
| `--display-mode` | 可选值: yoyMom（同比环比）、yoy（仅同比）、mom（仅环比）。默认 yoyMom |

### 不支持品类过滤

用户报表**不支持** `--category-type` / `--category` 等品类过滤参数。不要输出品类相关分析。

## 6. 完整示例

### 示例1：获取全国会员销售占比

```bash
qdm-cmr-cli report user indicators --indicator memberSaleAmtRate --display-mode yoyMom
```

### 示例2：获取粤西区域会员销售占比

```bash
qdm-cmr-cli report user indicators --indicator memberSaleAmtRate --area-type manageAreaId --area CN01 --display-mode yoyMom
```

### 示例3：获取会员销售占比趋势（近30天）

```bash
qdm-cmr-cli report user trend --indicator memberSaleAmtRate
```

### 示例4：获取各区域会员销售占比排名

```bash
qdm-cmr-cli report user area --indicator memberSaleAmtRate
```

## 7. 注意事项

1. **valueUnit=3**: 返回值是小数比率形式，展示时需乘以100转换为百分比（如0.693 -> 69.3%）。mom/yoy的unit=3也同理，表示百分点变化。
2. **阈值解读**: 阈值 GE 60%，即要求会员销售占比 >= 60%。华东区域（56.12%）未达标。
3. **同比环比方向**: mom和yoy中的arrowStatus/status显示"up"表示上升，"down"表示下降。但value的正负才是真实变化方向，status仅指示箭头方向。
4. **禁止品类维度**: 用户报表不支持品类过滤，不可使用 `--category-type` 或 `--category` 参数。
5. **默认区域**: 不指定区域时默认全国（不含港澳）CN00。
6. **指标层级**: 会员销售占比是一级核心指标（showTable），其子指标为交叉会员数（crossMemberNum）。如需下钻分析，可对交叉会员数进一步查询。
7. **禁止放入章节**: 严禁放入第三章（用户规模与分层结构）、第五章（用户触达与渠道效率），应归入第四章（会员价值与复购转化）。