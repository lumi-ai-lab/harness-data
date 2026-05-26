---
id: member-s-regular-active-member-num
kind: playbook
domain: member
title: 普通活跃会员数报告生成指引
tags:
  - report
  - playbook
  - user-report
  - regularActiveMemberNum
  - 普通活跃会员数
match:
  keywords:
    - 普通活跃会员数
    - 普通活跃会员数报告
    - 普通活跃会员数玩法
    - regularActiveMemberNum报告
---

# 普通活跃会员数报告生成指引

> 命令使用 `qdm-cmr-cli report user`，获取用户报表 `/report/3` 的普通活跃会员数指标分析。

## 1. 获取指标详情

```bash
qdm-cmr-cli indicator detail --code regularActiveMemberNum --full
```

输出示例：
```json
{
  "indicatorsName": "普通活跃会员数",
  "indicatorsCodeEn": "regularActiveMemberNum",
  "businessDefinition": "会员等级为普通会员的活跃会员",
  "statisticalLogic": "会员等级为普通会员的活跃会员id去重计数"
}
```

## 2. 获取指标值（含同比环比）

```bash
qdm-cmr-cli report user indicators --indicator regularActiveMemberNum --display-mode yoyMom
```

输出示例：
```json
{
  "filters": {
    "periodType": "DATE",
    "periodValue": "2026-05-24",
    "storeTypeId": "manageAreaId",
    "areaId": "CN00",
    "areaName": "全国(不含港澳)",
    "indicatorName": "普通活跃会员数",
    "displayMode": "yoyMom"
  },
  "items": [
    {
      "indicatorCode": "regularActiveMemberNum",
      "indicatorName": "普通活跃会员数",
      "value": 454.77,
      "valueUnit": 1,
      "zhCNUnit": "万",
      "yoy": { "arrowStatus": "up", "status": "up", "unit": 2, "value": -0.003 },
      "mom": { "arrowStatus": "up", "status": "up", "unit": 2, "value": 0.005 },
      "threshold": null
    }
  ]
}
```

**数据解读**：
- 当前值：454.77万（valueUnit=1，整数）
- 同比：-0.30%（unit=2），微降
- 环比：+0.50%（unit=2），微增
- 阈值：null

## 3. 获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator regularActiveMemberNum
```

## 4. 获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator regularActiveMemberNum
```

输出示例：
```json
{
  "filters": { "areaId": "CN00", "areaName": "全国(不含港澳)" },
  "grouping": "storeId",
  "rows": [
    { "code": "CN01", "name": "粤西", "current": 155.3362, "unit": "万",
      "mom": { "unit": 2, "value": 0.0049 }, "yoy": { "unit": 2, "value": -0.0070 } },
    { "code": "CN18", "name": "粤东", "current": 120.7833, "unit": "万",
      "mom": { "unit": 2, "value": 0.0052 }, "yoy": { "unit": 2, "value": -0.0068 } },
    { "code": "CN15", "name": "华东", "current": 26.1113, "unit": "万",
      "mom": { "unit": 2, "value": 0.0044 }, "yoy": { "unit": 2, "value": 0.0044 } },
    { "code": "CN07", "name": "运营直管", "current": 1.048, "unit": "万",
      "mom": { "unit": 2, "value": 0.0137 }, "yoy": { "unit": 2, "value": 0.0032 } }
  ]
}
```

**区域排名**：
1. 粤西：155.34万，环比+0.49%，同比-0.70%
2. 粤东：120.78万，环比+0.52%，同比-0.68%
3. 华东：26.11万，环比+0.44%，同比+0.44%
4. 运营直管：1.05万，环比+1.37%，同比+0.32%

## 5. 过滤条件说明

- **时间过滤**：通过 `--period-type` 和 `--period-value` 指定。
- **区域过滤**：通过 `--area-type` 和 `--area` 指定。默认 `manageAreaId / CN00`。
- **品类过滤**：用户报表不支持，不要使用 `--category-type` 或 `--category`。

## 6. 完整示例

### 示例1：全国概览
```bash
qdm-cmr-cli indicator detail --code regularActiveMemberNum --full
qdm-cmr-cli report user indicators --indicator regularActiveMemberNum --display-mode yoyMom
qdm-cmr-cli report user trend --indicator regularActiveMemberNum
qdm-cmr-cli report user area --indicator regularActiveMemberNum
```

### 示例2：粤西下钻
```bash
qdm-cmr-cli report user indicators --indicator regularActiveMemberNum --area-type manageAreaId --area CN01 --display-mode yoyMom
```

### 示例3：普通活跃会员及其子指标联动
```bash
qdm-cmr-cli report user indicators --indicator regularActiveMemberNum --display-mode yoyMom
qdm-cmr-cli report user indicators --indicator regularActiveMemberTranTimes --display-mode yoyMom
qdm-cmr-cli report user indicators --indicator regularActiveMemberPerCustAmt --display-mode yoyMom
```

## 7. 注意事项

- 普通活跃会员数是活跃用户数的子指标，固定放入第三章"用户规模与分层结构维度深度拆解"的会员分层活跃与价值指标组。
- 该指标在报告中需与vip1/vip2/vip3活跃会员数一起构成会员分层全景。
- 用户报表不支持品类过滤。
- valueUnit=1表示整数，zhCNUnit="万"表示单位为万。
- 同比/环比 unit=2 表示比率变化，需乘以100转为百分比展示。
- CLI未返回时不等于0，直接省略。