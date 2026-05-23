# 经营分析深度报告路由

命中 `query_type=business_overview` 时，只允许使用 `qdm-cmr-cli`。

`overview`、`indicators`、`tree --values`、`area`、`category`、`trend` 六个模块没有业务顺序依赖，允许并行执行。六个模块全部成功后，必须先执行：

```bash
python3 .claude/hooks/before-report-signal.py business-overview
```

六个模块全部成功取数后，下一步必须立即执行该 signal；signal 前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。

只有在该 signal 成功且后续收到 template 二阶段注入后，才允许生成最终报告正文；取数前已注入的 `spec/business-report.md` 在报告生成阶段继续遵守。signal 前不读取、不使用 template。

推荐并行命令族：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business overview --date <YYYY-MM-DD> --ai &
"$QDM_CMR_CLI" report business indicators --date <YYYY-MM-DD> --ai &
"$QDM_CMR_CLI" report business tree --values --date <YYYY-MM-DD> &
"$QDM_CMR_CLI" report business area --date <YYYY-MM-DD> --ai &
"$QDM_CMR_CLI" report business category --date <YYYY-MM-DD> --ai &
"$QDM_CMR_CLI" report business trend --date <YYYY-MM-DD> --ai &
wait

python3 .claude/hooks/before-report-signal.py business-overview
```

可选补充命令：

```bash
qdm-cmr-cli table --report business --date <YYYY-MM-DD> ... --ai
```

查询策略：

- 必须查询 `overview`、`indicators`、`tree --values`、`area`、`category`、`trend` 六个必要模块；六个模块可并行。
- 只有需要更细颗粒度佐证时才调用 `table`。
- `before-report-signal.py business-overview` 不并行，必须在并行查询整体成功后的下一步立即执行。
- 并行查询整体成功后、signal 前，不得先整理证据、总结素材、生成中间分析或输出阶段性结论。
- 对支持 `--ai` 的 CMR 查询，默认使用 AI 压缩输出以节省上下文 token；`tree --values` 当前不在支持清单内，继续使用默认 JSON 输出。
- 对 CLI 未返回的数据，不得自行估算。

禁止路由：

- 禁止把泛问经营概览路由到 `qdm-indicators-cli`。
- 禁止只使用 `qdm-indicators-cli` 生成经营分析报告。
- 禁止用本地静态示例值替代 CLI 返回值。
