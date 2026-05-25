# 客数指标报告意图

## Intent

当用户询问客数情况、客数为什么下降/提升、custNum 指标表现等问题时，识别为经营分析下客数渗透率树中的客数专项报告。

固定意图字段：

```yaml
query_type: business_cust_penetration_rate_cust_num
report: business
indicator: 客数
depth: metric_report
needs_clarification: false
```

## 命中表达

- 查看昨天的客数情况
- 分析昨日客数
- 客数为什么下降
- 客数为什么提升
- custNum 指标报告

## 非命中表达

- 查看昨天经营情况
- 客数渗透率情况
- 19点前客数情况
- 销售额情况
- 品效情况

## 固定约束

- 必须使用 `qdm-cmr-cli report business`，固定指标为 `客数`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 数值、排名、环比、同比、异常和根因必须来自 CLI 输出。
