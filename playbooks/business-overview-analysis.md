# 经营分析深度报告 Playbook

## 目标

把“查看经营情况”类问题输出为一份结构稳定、证据可追溯、可行动的经营分析深度报告。

分析主线固定为：

1. 用户渗透
2. 品效
3. 供应链

本 playbook 负责定义分析执行流程、必要证据、诊断方法和报告生成门禁；最终报告版式、章节顺序、指标归属和表格结构以 `templates/business-overview-report.md` 为准。

## 适用边界

适用于用户泛问经营情况、经营分析、整体经营表现、昨日/本周/本月经营复盘等问题。

不适用于：

- 单个指标查询或指标定义解释。
- 用户明确要求走指标平台、指标口径或非 CMR 报表的问题。
- 只查询门店、区域、品类、用户等单一明细，且没有经营概览或深度报告诉求的问题。

命中该 playbook 后，不向用户追问；若用户未给时间，默认使用昨天，并在报告概述中说明默认口径。

## 输入与口径确认

执行查询前先归一化以下口径：

- 时间口径：支持日期、周、月；用户给出明确时间时按用户输入执行。
- 筛选口径：保留用户指定的区域、品类、门店、指标等过滤条件；未指定时按全局口径。
- 报告范围：从 `overview` 返回结果中确认业务对象、时间范围和可用数据范围。

如 CLI 支持对应周期参数，优先使用 `--date`、`--week` 或 `--month` 表达原始时间口径，不把周/月问题强行拆成单日。

## 必要查询模块

使用 `qdm-cmr-cli report business`，按用户时间口径补充日期、周或月过滤。对支持 `--ai` 的模块默认追加 `--ai`，降低上下文 token 消耗；`tree --values` 保持默认 JSON 输出。

六个模块是硬性要求，模块之间没有业务顺序依赖，可以并行查询；必须全部成功后才能进入报告生成阶段，并在最终报告前执行 `python3 .claude/hooks/before-report-signal.py business-overview`。

- `overview`: 全局概览，确认报告对象、时间口径和整体表现。
- `indicators`: 核心指标总览，提取主要指标值、同比、环比、阈值或达成情况。
- `tree --values`: 一级指标到子指标的拆解路径，用于定位问题链路。
- `area`: 区域维度对比，用于发现区域拖累或亮点。
- `category`: 品类维度对比，用于发现品效、结构和动销问题。
- `trend`: 时间趋势，用于识别短期波动、持续下滑或异常峰谷。
- `table`: 可选。仅在需要门店、区域、品类或指标明细佐证时使用。

推荐并行查询方式：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business overview --date <YYYY-MM-DD> --ai &
"$QDM_CMR_CLI" report business indicators --date <YYYY-MM-DD> --ai &
"$QDM_CMR_CLI" report business tree --values --date <YYYY-MM-DD> &
"$QDM_CMR_CLI" report business area --date <YYYY-MM-DD> --ai &
"$QDM_CMR_CLI" report business category --date <YYYY-MM-DD> --ai &
"$QDM_CMR_CLI" report business trend --date <YYYY-MM-DD> --ai &
wait
```

- `overview --ai`: 确认对象、时间、整体表现。
- `indicators --ai`: 获取核心指标和主要子指标。
- `tree --values`: 获取指标拆解路径和指标归属线索，继续不加 `--ai`。
- `area --ai`: 获取区域结构差异。
- `category --ai`: 获取品类结构差异。
- `trend --ai`: 获取趋势、峰谷和异常持续性。
- `table --ai`: 可选，按需在六个必要模块之后补充。
- `before-report-signal.py business-overview` 不并行，必须在六个必要模块整体成功后单独执行。

## 分析步骤

1. 明确时间口径和筛选口径。
2. 并行查询 `overview`、`indicators`、`tree --values`、`area`、`category`、`trend` 六个必要模块。
3. 汇总指标全局视图和结构性证据。
4. 按用户渗透、品效、供应链三条主线组织诊断。
5. 将问题归纳为“现象 -> 影响 -> 推断”。
6. 输出优化建议，每条建议必须对应已识别问题或风险。
7. 对未返回的数据直接省略，不单列缺失项。
8. signal 成功并收到 `spec/business-report.md` 后，再输出最终报告正文。

## 证据整理方法

查询完成后，先整理证据，再写报告：

- 核心指标：只保留客数渗透率、品效、活跃供应商数，用于第二章核心指标总览。
- 维度证据：按用户渗透、品效、供应链三条主线分组，避免跨维度混放。
- 结构证据：从 `area`、`category`、`trend` 中挑选能解释核心问题的区域、品类、时间段证据。
- 诊断证据：每个关键问题至少绑定一个数值、排名、同比、环比、阈值或异常点。
- 建议证据：每条建议必须能回指第六章关键问题或第八章风险提示。

证据优先级：

1. `indicators` 和 `tree --values` 确认指标值、变化和拆解路径。
2. `trend` 判断问题是持续、短期波动还是异常峰谷。
3. `area` 判断区域拖累、亮点或分化。
4. `category` 判断品类贡献、拖累或结构性问题。
5. `table` 用于补充明细定位，不替代前六个必要模块。

## 三大主线取数要求

### 用户渗透

优先从 `indicators` 和 `tree --values` 提取客数渗透率、销售额、客数、客单价、19点前销售转化链路、全链路毛利率/毛利额、商品订购渗透等相关指标。

佐证来源：

- `trend`: 判断用户相关指标是否持续变化。
- `area`: 判断区域渗透差异。
- `table`: 必要时定位到区域或门店。

### 品效

优先从 `indicators` 和 `tree --values` 提取品效、定价毛利率、售价价格指数、预期毛利率、时段折扣率、促销折扣率、采购价格指数、出库折让率、损耗率等相关指标。

佐证来源：

- `category`: 判断品类贡献和拖累。
- `trend`: 判断品效变化节奏。
- `area`: 判断区域间品效差异。

### 供应链

优先从 `tree --values` 和 `indicators` 提取活跃供应商数、集采入库占比、三率综合得分、准确率、准点率、合格率等相关指标。

佐证来源：

- `category`: 判断品类供应链问题。
- `area`: 判断区域供应稳定性。
- `trend`: 判断异常是否集中在某一时间段。

## 报告模板

最终报告必须使用 `templates/business-overview-report.md`。

模板使用规则：

- 保持模板 1 到 9 章顺序，不自行增删一级章节。
- 模板中的指标归属、指标组和表格结构优先级高于自由组织。
- 生成前若已收到 `spec/business-report.md`，指标归属和禁放规则以该 spec 为准。
- CLI 未返回的指标行、指标组或段落直接省略，不写“暂无数据”“未返回”等缺失说明。
- 不把 `templates/business-overview-report.md` 中的占位符原样留在最终报告中。
- 最终报告正文只使用已查询到的 CLI 证据，不使用本地示例值或经验估算值。

模板与证据映射：

- 第一章：来自 `overview`，补充时间口径、筛选口径、数据来源和总体判断。
- 第二章：来自 `indicators` 和 `tree --values`，只展示三大一级核心指标。
- 第三章：填充用户渗透相关指标，并使用 `trend`、`area`、必要时 `table` 佐证。
- 第四章：填充品效相关指标，并使用 `category`、`trend`、`area` 佐证。
- 第五章：填充供应链相关指标，并使用 `tree --values`、`category`、`area`、`trend` 佐证。
- 第六章：把前三个维度的核心问题整理为“现象 -> 影响 -> 推断”。
- 第七章：给出与第六章问题一一对应的短期动作和长期动作。
- 第八章：只列已由 CLI 证据支持的风险和后续跟踪指标。
- 第九章：保留模板内可被当前报告使用的指标定义；未涉及指标可省略。

## 证据规则

- 数值、排名、同比、环比、阈值、异常点必须来自 CLI 输出。
- 推断必须可追溯到至少一条已返回数据。
- 不确定时使用“可能”“倾向于”，并说明证据边界。
- 不允许把通用业务常识写成已发生事实。

## 异常处理

- 若必要模块查询失败，先重试或调整合法参数；仍失败时不得生成最终报告。
- 若某个必要模块成功但返回数据为空，保留已返回证据继续分析，但不得补造缺失指标。
- 若不同模块对同一指标口径冲突，优先以 `indicators` 和 `tree --values` 的指标值为准，并用其他模块只做结构性佐证。
- 若 `before-report-signal.py business-overview` 未成功，或未收到 `spec/business-report.md`，不得输出最终报告正文。
- 若用户中途追加更具体的筛选条件，应按新条件重新确认时间和过滤口径，并重新完成必要模块查询。

## 最终输出检查

输出前逐项检查：

- 已完成 `overview`、`indicators`、`tree --values`、`area`、`category`、`trend` 六个必要模块。
- 已执行 `python3 .claude/hooks/before-report-signal.py business-overview` 并收到 `spec/business-report.md`。
- 报告使用 `templates/business-overview-report.md` 的 1 到 9 章结构。
- 第二章只展示客数渗透率、品效、活跃供应商数。
- 销售额、客数、客单价、19点前链路没有放入品效或供应链章节。
- 出库折让率没有放入供应链章节。
- 准确率、准点率、合格率没有放入品效章节。
- 所有数值和诊断事实都能回溯到 CLI 输出。
- 没有遗留模板占位符、示例值或未返回指标。
