# 售价价格指数指标报告意图

## Intent

当用户询问售价价格指数情况、售价价格指数为什么下降/提升、priceIndex 指标表现等问题时，识别为经营分析下品效树中的售价价格指数(线上)专项报告。

固定意图字段：

```yaml
query_type: business_brand_product_effectiveness_price_index
report: business
indicator: 售价价格指数(线上)
depth: metric_report
needs_clarification: false
```

## 命中表达

- 查看昨天的售价价格指数情况
- 查看昨天的售价价格指数(线上)情况
- 售价价格指数为什么下降
- 售价价格指数为什么提升
- priceIndex 指标报告

## 非命中表达

- 查看昨天经营情况
- 品效情况
- 采购价格指数情况
- 商品订购渗透率情况
- 定价毛利率情况

## 固定约束

- 必须使用 `qdm-cmr-cli report business`，固定指标为 `售价价格指数(线上)`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 数值、排名、环比、同比、阈值、异常和根因必须来自 CLI 输出。
