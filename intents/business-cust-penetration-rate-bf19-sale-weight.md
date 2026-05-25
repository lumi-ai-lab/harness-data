# 19点前销售重量指标报告意图

## Intent

当用户询问19点前销售重量情况、19点前销售重量为什么下降/提升、bf19SaleWeight 指标表现等问题时，识别为经营分析下客数渗透率树中的19点前销售重量专项报告。

固定意图字段：

```yaml
query_type: business_cust_penetration_rate_bf19_sale_weight
report: business
indicator: 19点前销售重量
depth: metric_report
needs_clarification: false
```

## 命中表达

- 查看昨天的19点前销售重量情况
- 19点前销售重量为什么下降
- 19点前销售重量为什么提升
- bf19SaleWeight 指标报告

## 非命中表达

- 查看昨天经营情况
- 销售额情况
- 19点前销售占比情况
- 订单满足率情况
- 客数情况
- 客单价情况

## 固定约束

- 必须使用 `qdm-cmr-cli report business`，固定指标为 `19点前销售重量`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 数值、排名、环比、同比、阈值、异常和根因必须来自 CLI 输出。
