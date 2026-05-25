# 19点前单均件数指标报告意图

## Intent

当用户询问 19点前单均件数情况、19点前单均件数为什么下降/提升、bf19AvgPieceNum 指标表现等问题时，识别为经营分析下客数渗透率树中的 19点前单均件数专项报告。

固定意图字段：

```yaml
query_type: business_cust_penetration_rate_bf19_avg_piece_num
report: business
indicator: 19点前单均件数
depth: metric_report
needs_clarification: false
```

## 命中表达

- 查看昨天的19点前单均件数情况
- 19点前单均件数为什么下降
- 19点前单均件数为什么提升
- bf19AvgPieceNum 指标报告

## 非命中表达

- 查看昨天经营情况
- 19点前客单价情况
- 19点前件单价情况
- 客单价情况
- 销售额情况

## 固定约束

- 必须使用 `qdm-cmr-cli report business`，固定指标为 `19点前单均件数`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 数值、排名、环比、同比、阈值、异常和根因必须来自 CLI 输出。
