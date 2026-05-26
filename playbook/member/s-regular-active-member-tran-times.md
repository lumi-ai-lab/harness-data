---
id: member-s-regular-active-member-tran-times
kind: playbook
domain: member
title: 普通活跃会员消费频次报告生成指引
tags:
  - report
  - playbook
  - user-report
  - regularActiveMemberTranTimes
  - 普通活跃会员消费频次
match:
  keywords:
    - 普通活跃会员消费频次
    - 普通活跃会员消费频次报告
    - regularActiveMemberTranTimes报告
---

# 普通活跃会员消费频次报告生成指引

> 命令使用 `qdm-cmr-cli report user`，获取用户报表 `/report/3` 的普通活跃会员消费频次指标分析。

## 1. 获取指标详情

```bash
qdm-cmr-cli indicator detail --code regularActiveMemberTranTimes --full
```

输出示例：
```json
{
  "indicatorsName": "普通活跃会员消费频次",
  "indicatorsCodeEn": "regularActiveMemberTranTimes",
  "businessDefinition": "会员等级为普通会员的活跃会员，平均每位会员在统计周期内的消费次数",
  "statisticalLogic": "统计周期内，普通活跃会员来客数 / 普通活跃会员消费人数"
}
```

## 2. 获取指标值（含同比环比）

```bash
qdm-cmr-cli report user indicators --indicator regularActiveMemberTranTimes --display-mode yoyMom
```

输出示例：
```json
{
  "items": [
    {
      "indicatorCode": "regularActiveMemberTranTimes",
      "indicatorName": "普通活跃会员消费频次",
      "value": 1.1119695476212272,
      "valueUnit": 2,
      "zhCNUnit": "",
      "yoy": { "status": "up", "unit": 2, "value": -0.0009 },
      "mom": { "status": "up", "unit": 2, "value": -0.0058 },
      "threshold": null
    }
  ]
}
```

**数据解读**：
- 当前值：1.11次（valueUnit=2，百分比/比率类型）
- 同比：-0.09%（unit=2），微降
- 环比：-0.58%（unit=2），小幅下降

## 3. 获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator regularActiveMemberTranTimes
```

## 4. 获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator regularActiveMemberTranTimes
```

输出示例：
```json
{
  "grouping": "storeId",
  "rows": [
    { "code": "CN15", "name": "华东", "current": 1.117573,
      "mom": { "unit": 2, "value": -0.0059 }, "yoy": { "unit": 2, "value": 0.0032 } },
    { "code": "CN07", "name": "运营直管", "current": 1.115323,
      "mom": { "unit": 2, "value": -0.0443 }, "yoy": { "unit": 2, "value": -0.0068 } },
    { "code": "CN18", "name": "粤东", "current": 1.105909,
      "mom": { "unit": 2, "value": -0.0027 }, "yoy": { "unit": 2, "value": -0.0017 } },
    { "code": "CN01", "name": "粤西", "current": 1.105405,
      "mom": { "unit": 2, "value": -0.0036 }, "yoy": { "unit": 2, "value": -0.0002 } }
  ]
}
```

**区域排名**：
1. 华东：1.12次，环比-0.59%，同比+0.32%
2. 运营直管：1.12次，环比-4.43%，同比-0.68%
3. 粤东：1.11次，环比-0.27%，同比-0.17%
4. 粤西：1.11次，环比-0.36%，同比-0.02%

## 5. 过滤条件说明

- **时间过滤**：通过 `--period-type` 和 `--period-value` 指定。默认最近一天。
- **区域过滤**：通过 `--area-type` 和 `--area` 指定。
- **品类过滤**：用户报表不支持。

## 6. 完整示例

### 示例1：全国概览
```bash
qdm-cmr-cli indicator detail --code regularActiveMemberTranTimes --full
qdm-cmr-cli report user indicators --indicator regularActiveMemberTranTimes --display-mode yoyMom
qdm-cmr-cli report user trend --indicator regularActiveMemberTranTimes
qdm-cmr-cli report user area --indicator regularActiveMemberTranTimes
```

### 示例2：粤西下钻
```bash
qdm-cmr-cli report user indicators --indicator regularActiveMemberTranTimes --area-type manageAreaId --area CN01 --display-mode yoyMom
```

### 示例3：华东下钻
```bash
qdm-cmr-cli report user indicators --indicator regularActiveMemberTranTimes --area-type manageAreaId --area CN15 --display-mode yoyMom
```

## 7. 注意事项

- 该指标是叶子指标，无下钻子指标。
- 固定归入第三章"用户规模与分层结构维度深度拆解"的会员分层活跃与价值指标组。
- 用户报表不支持品类过滤。
- valueUnit=2表示百分比/比率类型。
- CLI未返回时不等于0，直接省略。