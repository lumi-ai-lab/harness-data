---
id: member-s-regular-active-member-per-cust-amt
kind: playbook
domain: member
title: 普通活跃会员客单价报告生成指引
tags:
  - report
  - playbook
  - user-report
  - regularActiveMemberPerCustAmt
  - 普通活跃会员客单价
match:
  keywords:
    - 普通活跃会员客单价
    - 普通活跃会员客单价报告
    - regularActiveMemberPerCustAmt报告
---

# 普通活跃会员客单价报告生成指引

> 命令使用 `qdm-cmr-cli report user`，获取用户报表 `/report/3` 的普通活跃会员客单价指标分析。

## 1. 获取指标详情

```bash
qdm-cmr-cli indicator detail --code regularActiveMemberPerCustAmt --full
```

输出示例：
```json
{
  "indicatorsName": "普通活跃会员客单价",
  "indicatorsCodeEn": "regularActiveMemberPerCustAmt",
  "businessDefinition": "会员等级为普通会员的活跃会员，他们产生的订单的平均销售额",
  "statisticalLogic": "普通活跃会员销售额 / 普通活跃会员来客数"
}
```

## 2. 获取指标值（含同比环比）

```bash
qdm-cmr-cli report user indicators --indicator regularActiveMemberPerCustAmt --display-mode yoyMom
```

输出示例：
```json
{
  "items": [
    {
      "indicatorCode": "regularActiveMemberPerCustAmt",
      "indicatorName": "普通活跃会员客单价",
      "value": 18.776786,
      "valueUnit": 2,
      "zhCNUnit": "",
      "yoy": { "status": "up", "unit": 2, "value": 0.0064 },
      "mom": { "status": "up", "unit": 2, "value": -0.0423 },
      "threshold": null
    }
  ]
}
```

**数据解读**：
- 当前值：18.78元（valueUnit=2）
- 同比：+0.64%（unit=2），微增
- 环比：-4.23%（unit=2），下降

## 3. 获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator regularActiveMemberPerCustAmt
```

输出示例：
```json
{
  "grouping": "storeId",
  "rows": [
    { "code": "CN18", "name": "粤东", "current": 21.292559,
      "mom": { "unit": 2, "value": -0.0394 }, "yoy": { "unit": 2, "value": -0.0005 } },
    { "code": "CN15", "name": "华东", "current": 20.977664,
      "mom": { "unit": 2, "value": 0.0940 }, "yoy": { "unit": 2, "value": 0.0729 } },
    { "code": "CN01", "name": "粤西", "current": 19.490014,
      "mom": { "unit": 2, "value": -0.0548 }, "yoy": { "unit": 2, "value": -0.0032 } },
    { "code": "CN07", "name": "运营直管", "current": 18.950788,
      "mom": { "unit": 2, "value": -0.1975 }, "yoy": { "unit": 2, "value": 0.0197 } }
  ]
}
```

**区域排名**：
1. 粤东：21.29元，环比-3.94%，同比-0.05%
2. 华东：20.98元，环比+9.40%，同比+7.29%
3. 粤西：19.49元，环比-5.48%，同比-0.32%
4. 运营直管：18.95元，环比-19.75%，同比+1.97%

## 4. 过滤条件说明

- **时间过滤**：通过 `--period-type` 和 `--period-value` 指定。
- **区域过滤**：通过 `--area-type` 和 `--area` 指定。
- **品类过滤**：用户报表不支持。

## 5. 完整示例

### 示例1：全国概览
```bash
qdm-cmr-cli indicator detail --code regularActiveMemberPerCustAmt --full
qdm-cmr-cli report user indicators --indicator regularActiveMemberPerCustAmt --display-mode yoyMom
qdm-cmr-cli report user area --indicator regularActiveMemberPerCustAmt
```

### 示例2：粤东下钻
```bash
qdm-cmr-cli report user indicators --indicator regularActiveMemberPerCustAmt --area-type manageAreaId --area CN18 --display-mode yoyMom
```

### 示例3：华东下钻
```bash
qdm-cmr-cli report user indicators --indicator regularActiveMemberPerCustAmt --area-type manageAreaId --area CN15 --display-mode yoyMom
```

## 6. 注意事项

- 该指标是叶子指标，无下钻子指标。
- 固定归入第三章"用户规模与分层结构维度深度拆解"的会员分层活跃与价值指标组。
- 与普通活跃会员消费频次配合，完整描述普通会员的消费价值。
- 用户报表不支持品类过滤。
- valueUnit=2表示百分比/比率类型。
- CLI未返回时不等于0，直接省略。