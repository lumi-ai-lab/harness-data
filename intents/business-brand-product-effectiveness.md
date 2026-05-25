# 品效下钻报告意图

## Intent

当用户询问品效情况、品效下钻、品效为什么下降/提升、商品经营效率等问题时，识别为经营分析下的品效专项下钻报告。

固定意图字段：

```yaml
query_type: business_brand_product_effectiveness
report: business
indicator: 品效
depth: drill_report
needs_clarification: false
```

## 命中表达

包括但不限于：

- 查看昨天的品效情况
- 分析昨日品效
- 品效为什么下降
- 品效为什么提升
- 看一下商品经营效率
- 品效下钻报告

## 时间解析

- 用户给出明确日期时，按用户日期执行。
- “昨天”解析为当前日期前一天。
- “今天”解析为当前日期。
- “本周”“本月”等周期问题保留周期粒度，并尽量使用 CLI 支持的 `--week` 或 `--month`。
- 如果用户没有给时间，默认使用昨天，并在报告概述中说明默认口径。

## 固定约束

- 不需要向用户追问。
- 必须使用 `qdm-cmr-cli report business`，固定指标为 `品效`。
- 必须完成 `indicators`、`tree --values`、`tree --chart`、`area`、`category`、`trend` 六个必要模块。
- 六个模块全部成功取数后，下一步必须立即执行 `bin/data-harness-cli inject-template`。
- 收到 template 二阶段注入后，再按品效下钻模板输出最终报告。
- 数值、排名、环比、同比、阈值、异常和根因必须来自 CLI 输出。
- 不得使用本地 demo 数据、静态示例值或经验估算值。
