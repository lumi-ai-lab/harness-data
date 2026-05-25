# 损耗率指标报告意图

## Intent

当用户询问损耗率情况、损耗率为什么下降/提升、lostRate 指标表现等问题时，识别为经营分析下品效树中定价毛利率链路的损耗率专项报告。

固定意图字段：

```yaml
query_type: business_brand_product_effectiveness_lost_rate
report: business
indicator: 损耗率
depth: metric_report
needs_clarification: false
```

## 命中表达

- 查看昨天的损耗率情况
- 分析昨日损耗率
- 损耗率为什么下降
- 损耗率为什么提升
- lostRate 指标报告

## 非命中表达

- 查看昨天经营情况
- 品效情况
- 定价毛利率情况
- 预期毛利率情况
- 出库折让率情况
- 时段折扣率情况
- 促销折扣率情况
- 商品订购渗透率情况
- 售价价格指数情况

## 固定约束

- 必须使用 `qdm-cmr-cli report business`，固定指标为 `损耗率`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 数值、排名、环比、同比、阈值、异常和根因必须来自 CLI 输出。
