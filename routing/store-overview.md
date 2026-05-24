# 门店管理深度报告路由

命中 `query_type=store_overview` 时，只允许使用 `qdm-cmr-cli`。

CMR CLI 参数格式、时间过滤、`--ai` 白名单和失败重试规则以 `spec/cmr-cli-readme.md` 与 `spec/qdm-time-policy.md` 为准。

默认全国全品类场景下，`overview` 是唯一必需模块。`overview` 成功后，必须先执行：

```bash
python3 .claude/hooks/before-report-signal.py store-overview
```

`overview` 成功取数后，下一步必须立即执行该 signal；signal 前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。

只有在该 signal 成功且后续收到 template 二阶段注入后，才允许生成最终报告正文；取数前已注入的 `spec/store-report.md` 在报告生成阶段继续遵守。signal 前不读取、不使用 template。

推荐命令族：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report store overview <time_filter> --area-type 管理区域 --area CN00 --category-type 大分类 --category 00 --ai

python3 .claude/hooks/before-report-signal.py store-overview
```

可选补充命令：

```bash
"$QDM_CMR_CLI" report store inspect <time_filter> --area-type 管理区域 --area CN00 --category-type 大分类 --category 00
"$QDM_CMR_CLI" report store tree --values <time_filter> --area-type 管理区域 --area CN00 --category-type 大分类 --category 00
"$QDM_CMR_CLI" table --report store <time_filter> --area-type 管理区域 --area CN00 --category-type 大分类 --category 00 --indicator 营业门店数 --dim-type 管理区域 --ai
```

查询策略：

- 必须查询 `report store overview --ai`。
- 默认全国全品类场景不主动拆分为多个独立模块。
- 只有在用户指定非全国区域、`overview` 口径异常、区域子指标明细不足或需要校验图谱时，才允许补充 `inspect`、`tree --values` 或 `table`。
- `before-report-signal.py store-overview` 不并行，必须在 `overview` 成功后的下一步立即执行。
- `overview` 成功后、signal 前，不得先整理证据、总结素材、生成中间分析或输出阶段性结论。
- 对 CLI 未返回的数据，不得自行估算。

禁止路由：

- 禁止把门店管理报告路由到 `qdm-indicators-cli`。
- 禁止为门店管理报告生成品类下钻分析。
- 禁止用本地静态示例值替代 CLI 返回值。
