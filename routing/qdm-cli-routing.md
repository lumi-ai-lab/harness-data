# QDM CLI 路由规则

## 经营分析深度报告

命中 `query_type=business_overview` 时，只允许使用 `qdm-cmr-cli`。

`overview`、`indicators`、`tree --values`、`area`、`category`、`trend` 六个模块没有业务顺序依赖，允许并行执行。六个模块全部成功后，必须先执行：

```bash
python3 .claude/hooks/before-report-signal.py business-overview
```

只有在该 signal 成功且后续收到 `spec/business-report.md` 完整注入后，才允许生成最终报告正文。

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

## 禁止路由

- 禁止把泛问经营概览路由到 `qdm-indicators-cli`。
- 禁止只使用 `qdm-indicators-cli` 生成经营分析报告。
- 禁止用本地静态示例值替代 CLI 返回值。

## CLI 路径配置

- CLI 绝对路径集中配置在当前项目的 `config/qdm-cli-paths.env`。
- 当前 CMR CLI：`/Users/pengmd/c/qdm/cmr-cli/dist/qdm-cmr-cli`。
- 当前 Indicators CLI：`/Users/pengmd/c/qdm/indicators-cli/dist/qdm-indicators-cli`。
- 需要认证时，沿用项目 hook 写入的 `QDM_CMR_CONFIG_DIR` 配置目录。

## 查询策略

- 必须查询 `overview`、`indicators`、`tree --values`、`area`、`category`、`trend` 六个必要模块；六个模块可并行。
- 只有需要更细颗粒度佐证时才调用 `table`。
- `before-report-signal.py business-overview` 不并行，必须在并行查询整体成功后执行。
- 对支持 `--ai` 的 CMR 查询，默认使用 AI 压缩输出以节省上下文 token；`tree --values` 当前不在支持清单内，继续使用默认 JSON 输出。
- 对 CLI 未返回的数据，不得自行估算。
