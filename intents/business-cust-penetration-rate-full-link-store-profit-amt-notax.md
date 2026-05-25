# 全链路毛利额指标报告意图

## Intent

当用户询问全链路毛利额情况、全链路毛利额为什么下降/提升、fullLinkStoreProfitAmtNotax 指标表现等问题时，识别为经营分析下客数渗透率树中的全链路毛利额专项报告。

固定意图字段：

```yaml
query_type: business_cust_penetration_rate_full_link_store_profit_amt_notax
report: business
indicator: 全链路毛利额
depth: metric_report
needs_clarification: false
```

## 命中表达

- 查看昨天的全链路毛利额情况
- 分析昨日全链路毛利额
- 全链路毛利额为什么下降
- 全链路毛利额为什么提升
- fullLinkStoreProfitAmtNotax 指标报告

## 非命中表达

- 查看昨天经营情况
- 门店毛利额情况
- 供应链毛利额情况
- 全链路毛利率情况
- 销售额情况
- 客数情况
- 客单价情况
- 品效情况

## 固定约束

- 必须使用 `qdm-cmr-cli report business`，固定指标为 `全链路毛利额`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 数值、排名、环比、同比、阈值、异常和根因必须来自 CLI 输出。
