# 财务核心指标深度报告意图

## Intent

当用户询问财务报表、公司报表、公司财务情况、盈利情况、利润表现、EBITDA、营业收入、毛利额、费用率等问题时，识别为财务核心指标深度报告。

固定意图字段：

```yaml
query_type: financial_overview
report: company
needs_clarification: false
depth: deep_report
```

## 命中表达

包括但不限于：

- 查看昨天的财务报表
- 昨天公司财务情况怎么样
- 帮我分析昨日盈利表现
- 看一下整体财务分析
- 出一份公司报表分析
- 复盘本周 EBITDA 表现
- 分析本月营业收入、毛利和费用情况

## 时间解析

- 公司/财务报表不支持日维度，只支持周、月。
- 用户给出明确日期时，先解析出该日期，再转换为该日期所在 ISO 周，使用 `--week YYYY-Www`。
- “昨天”解析为当前日期前一天所在 ISO 周。
- “今天”解析为当前日期所在 ISO 周。
- “本周”“上周”等周期问题使用 `--week YYYY-Www`。
- “本月”“上月”等周期问题使用 `--month YYYY-MM`。
- 如果用户没有给时间，默认使用昨天所在 ISO 周，并在报告概述中说明“不支持日维度，已按所在周统计”。

## 固定约束

- 这是财务核心指标深度报告，不是普通摘要。
- 不需要向用户追问。
- 区域维度可选；用户未指定区域时不强制追加区域过滤，按 CLI 默认全国口径执行。
- 品类维度不可选，默认全品类；不得传入 `--category-type` 或 `--category`。
- 日期维度不支持日粒度；不得对 company 报表使用 `--date`。
- 必须完成 `qdm-cmr-cli report company indicators --ai`、`qdm-cmr-cli report company tree --values`、`qdm-cmr-cli table --report company --indicator EBITDA --dim-type 管理区域 --ai` 三个必需取数动作。
- `indicators --ai`、`table --ai` 优先使用 AI 压缩输出；`tree --values` 当前不支持 `--ai`，保持默认 JSON 输出。
- `overview --ai`、`area --ai`、`category --ai`、`trend --ai` 已实测无法稳定补齐财务模板指标，不作为默认必需模块。
- spec 已在取数前注入，必须用于取数和业务规则判断；template 注入前不读取、不使用 template。
- 三个必需取数动作全部成功后，下一步必须立即执行 `bin/data-harness-cli inject-template`，收到 template 二阶段注入后再输出最终报告。
- 取数完成后、template 注入前，禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 最终报告必须等 template 注入后收到 template，再按 template 固定章节输出。
- 诊断可以做有限推断，但必须绑定已返回数据。
- 不得编造数值、排名、环比、同比、阈值或原因。

## 非命中

以下问题不归入本意图：

- 泛问经营概览、销售经营分析、品效或供应链整体分析，且未表达财务/公司报表诉求的问题。
- 门店管理、门店规模、门店利润或门店运营效率分析。
- 用户运营、会员运营、用户留存或会员复购分析。
- 单个自由指标查询，例如“查一下 EBITDA 指标定义”。
- 明确要求走指标平台或指标口径解释的问题。
