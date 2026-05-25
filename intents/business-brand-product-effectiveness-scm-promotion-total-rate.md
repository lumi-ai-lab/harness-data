# 出库折让率指标报告意图

## Intent

当用户询问出库折让率情况、出库折让率为什么下降/提升、scmPromotionTotalRate 指标表现等问题时，识别为经营分析下品效树中定价毛利率链路的出库折让率专项报告。

固定意图字段：

```yaml
query_type: business_brand_product_effectiveness_scm_promotion_total_rate
report: business
indicator: 出库折让率
depth: metric_report
needs_clarification: false
```

## 命中表达

- 查看昨天的出库折让率情况
- 出库折让率为什么下降
- 出库折让率为什么提升
- scmPromotionTotalRate 指标报告

## 非命中表达

- 查看昨天经营情况
- 品效情况
- 定价毛利率情况
- 预期毛利率情况
- 时段折扣率情况

## 固定约束

- 必须使用 `qdm-cmr-cli report business`，固定指标为 `出库折让率`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 数值、排名、环比、同比、阈值、异常和根因必须来自 CLI 输出。
