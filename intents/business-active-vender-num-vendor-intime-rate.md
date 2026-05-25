# 准点率指标报告意图

## Intent

当用户询问准点率情况、准点率为什么下降/提升、vendorIntimeRate 指标表现等问题时，识别为经营分析下活跃供应商数树中的准点率专项报告。

固定意图字段：

```yaml
query_type: business_active_vender_num_vendor_intime_rate
report: business
indicator: 准点率
depth: metric_report
needs_clarification: false
```

## 命中表达

- 查看昨天的准点率情况
- 准点率为什么下降
- 准点率为什么提升
- vendorIntimeRate 指标报告

## 非命中表达

- 查看昨天经营情况
- 活跃供应商数情况
- 三率综合得分情况
- 准确率情况
- 合格率情况
- 集采入库占比情况
- 品效情况
- 客数渗透率情况

## 固定约束

- 必须使用 `qdm-cmr-cli report business`，固定指标为 `准点率`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 数值、排名、环比、同比、阈值、异常和根因必须来自 CLI 输出。
