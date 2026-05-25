# 商品订购渗透率指标报告意图

## Intent

当用户询问商品订购渗透率情况、商品订购渗透率为什么下降/提升、orderArticleRate 指标表现等问题时，识别为经营分析下品效树中的商品订购渗透率专项报告。

固定意图字段：

```yaml
query_type: business_brand_product_effectiveness_order_article_rate
report: business
indicator: 商品订购渗透率
depth: metric_report
needs_clarification: false
```

## 命中表达

- 查看昨天的商品订购渗透率情况
- 分析昨日商品订购渗透率
- 商品订购渗透率为什么下降
- 商品订购渗透率为什么提升
- orderArticleRate 指标报告

## 非命中表达

- 查看昨天经营情况
- 品效情况
- 订购门店数情况
- 可订门店数情况
- 定价毛利率情况
- 售价价格指数情况
- 采购价格指数情况

## 固定约束

- 必须使用 `qdm-cmr-cli report business`，固定指标为 `商品订购渗透率`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 数值、排名、环比、同比、阈值、异常和根因必须来自 CLI 输出。
