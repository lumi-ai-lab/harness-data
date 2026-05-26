# 交叉会员数（crossMemberNum）Playbook

## 1. 获取指标详情

```bash
qdm-cmr-cli indicator detail --code crossMemberNum --full
```

返回示例：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "businessDefinition": "同时在线上和线下都有过至少一次消费的会员数量",
    "indicatorsCodeEn": "crossMemberNum",
    "indicatorsName": "交叉会员数",
    "statisticalLogic": "同时在线上和线下都有过至少一次消费的会员id去重计数"
  }
}
```

## 2. 获取指标值（含同比环比）

```bash
qdm-cmr-cli report user indicators --indicator crossMemberNum --display-mode yoyMom
```

返回示例（仅贴crossMemberNum核心字段）：

```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeId": "manageAreaId",
    "storeTypeName": "管理区域",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorsCodeEn": "crossMemberNum",
    "indicatorName": "交叉会员数",
    "displayMode": "yoyMom"
  },
  "items": [
    {
      "indicatorCode": "crossMemberNum",
      "indicatorName": "交叉会员数",
      "value": 11136,
      "valueUnit": 1,
      "threshold": null,
      "mom": {
        "arrowStatus": "up",
        "status": "up",
        "unit": 2,
        "value": -0.0348
      },
      "yoy": {
        "arrowStatus": "up",
        "status": "up",
        "unit": 2,
        "value": 0.1747
      }
    }
  ]
}
```

**字段说明**:
- `value`: 11136，valueUnit=1表示整数
- `threshold`: null（无阈值配置）
- `mom.value`: -0.0348，unit=2，即环比下降3.48%
- `yoy.value`: 0.1747，unit=2，即同比增长17.47%

## 3. 获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator crossMemberNum
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
    {"compare": 7848,  "current": 6937,  "period": "2026/05/22"},
    {"compare": 8532,  "current": 11538, "period": "2026/05/23"},
    {"compare": 11343, "current": 11136, "period": "2026/05/24"}
  ]
}
```

**字段说明**: `compare` 为去年同期值，`current` 为当前值。

## 4. 获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator crossMemberNum
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
      "current": 4665,
      "mom": {"unit": 2, "value": -0.1060},
      "yoy": {"unit": 2, "value": 0.0714}
    },
    {
      "code": "CN18", "name": "粤东",
      "current": 3880,
      "mom": {"unit": 2, "value": -0.1245},
      "yoy": {"unit": 2, "value": 0.0018}
    },
    {
      "code": "CN15", "name": "华东",
      "current": 454,
      "mom": {"unit": 2, "value": -0.3100},
      "yoy": {"unit": 2, "value": -0.0735}
    },
    {
      "code": "CN07", "name": "运营直管",
      "current": 25,
      "mom": {"unit": 2, "value": -0.5690},
      "yoy": {"unit": 2, "value": -0.3421}
    }
  ],
  "sort": {"field": "current", "order": "DESC"}
}
```

**区域排名**: 粤西(4665) > 粤东(3880) > 华东(454) > 运营直管(25)

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

### 示例1：获取全国交叉会员数

```bash
qdm-cmr-cli report user indicators --indicator crossMemberNum --display-mode yoyMom
```

### 示例2：获取粤西区域交叉会员数

```bash
qdm-cmr-cli report user indicators --indicator crossMemberNum --area-type manageAreaId --area CN01 --display-mode yoyMom
```

### 示例3：获取交叉会员数趋势（近30天）

```bash
qdm-cmr-cli report user trend --indicator crossMemberNum
```

### 示例4：获取各区域交叉会员数排名

```bash
qdm-cmr-cli report user area --indicator crossMemberNum
```

## 7. 注意事项

1. **valueUnit=1**: 返回值为整数，无需额外转换。
2. **mom/yoy unit=2**: 表示比率变化（如-0.0348表示环比下降3.48%）。
3. **无阈值**: 交叉会员数无阈值配置，不需要与目标值对比。
4. **禁止品类维度**: 用户报表不支持品类过滤，不可使用 `--category-type` 或 `--category` 参数。
5. **默认区域**: 不指定区域时默认全国（不含港澳）CN00。
6. **子指标**: 交叉会员数可下钻到线下消费会员数（offlineMemberNum）和线上消费会员数（onlineMemberNum）。
7. **禁止放入章节**: 严禁放入第三章（用户规模与分层结构）、第五章（用户触达与渠道效率），应归入第四章（会员价值与复购转化）。