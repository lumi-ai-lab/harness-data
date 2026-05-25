# 订购门店数指标报告意图

## Intent

当用户询问订购门店数情况、订购门店数为什么下降/提升、orderStores 指标表现等问题时，识别为经营分析下品效树中商品订购渗透率链路的订购门店数专项报告。

固定意图字段：

```yaml
query_type: business_brand_product_effectiveness_order_stores
report: business
indicator: 订购门店数
depth: metric_report
needs_clarification: false
```

## 命中表达

- 查看昨天的订购门店数情况
- 订购门店数为什么下降
- 订购门店数为什么提升
- orderStores 指标报告

## 非命中表达

- 查看昨天经营情况
- 品效情况
- 商品订购渗透率情况
- 可订门店数情况
- 定价毛利率情况

## 固定约束

- 必须使用 `qdm-cmr-cli report business`，固定指标为 `订购门店数`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 数值、排名、环比、同比、阈值、异常和根因必须来自 CLI 输出。
