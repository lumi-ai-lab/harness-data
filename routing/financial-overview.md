# 财务核心指标深度报告路由

命中 `query_type=financial_overview` 时，只允许使用 `qdm-cmr-cli`。

CMR CLI 参数格式、时间过滤、`--ai` 白名单和失败重试规则以 `spec/cmr-cli-readme.md` 与 `spec/qdm-time-policy.md` 为准。

默认全品类场景下，必须完成 `indicators`、`tree --values`、`table(EBITDA, 管理区域)` 三个必需取数动作。三个动作全部成功后，必须先执行：

```bash
python3 .claude/hooks/before-report-signal.py financial-overview
```

三个必需取数动作成功后，下一步必须立即执行该 signal；signal 前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。

只有在该 signal 成功且后续收到 template 二阶段注入后，才允许生成最终报告正文；取数前已注入的 `spec/financial-report.md` 在报告生成阶段继续遵守。signal 前不读取、不使用 template。

推荐命令族：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report company indicators <time_filter> --ai
"$QDM_CMR_CLI" report company tree --values <time_filter>
"$QDM_CMR_CLI" table --report company <time_filter> --indicator EBITDA --dim-type 管理区域 --ai

python3 .claude/hooks/before-report-signal.py financial-overview
```

可选补充命令：

```bash
"$QDM_CMR_CLI" report company inspect <time_filter>
"$QDM_CMR_CLI" report company overview <time_filter> --ai
"$QDM_CMR_CLI" table --report company <time_filter> --indicator EBITDA --dim-type 大分类 --ai
```

查询策略：

- 必须查询 `report company indicators --ai`，用于获取可用指标的当前值、同比、环比。
- 必须查询 `report company tree --values`，用于获取 EBITDA 财务指标树和部分树节点当前值；该命令不追加 `--ai`。
- 必须查询 `table --report company --indicator EBITDA --dim-type 管理区域 --ai`，用于获取 EBITDA 树下收入、毛利、费用结构当前值。
- company 报表只支持 `--week` 或 `--month`；禁止使用 `--date`。
- 用户询问昨天、今天或具体日期时，必须转换为该日期所在 QDM 业务周，并在最终报告中说明不支持日维度。
- 品类维度不可选，禁止追加 `--category-type` 或 `--category`；报告中固定写为全品类。
- 区域维度可选；用户未指定区域时不强制追加 `--area-type` 或 `--area`。
- 默认不把 `overview`、`area`、`category`、`trend` 作为必需模块；实测这些模块在默认 EBITDA 指标下对财务模板补数价值有限或返回空。
- 只有在用户指定区域、口径异常或需要额外下钻时，才允许补充 `inspect`、`overview --ai`、`area --ai`、`category --ai`、`trend --ai` 或额外 `table`；用户提出品类筛选时必须说明 company 报表不支持品类维度。
- `before-report-signal.py financial-overview` 不并行，必须在三个必需取数动作成功后的下一步立即执行。
- 必需取数动作成功后、signal 前，不得先整理证据、总结素材、生成中间分析或输出阶段性结论。
- 对 CLI 未返回的数据，不得自行估算。

禁止路由：

- 禁止把财务核心指标报告路由到 `qdm-indicators-cli`。
- 禁止用经营分析、门店管理或用户报表的静态示例值替代公司报表返回值。
- 禁止用模板中的 demo 数值替代 CLI 返回值。
