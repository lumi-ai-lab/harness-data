---
id: routing-member-overview
kind: routing
domain: member
title: 用户运营路由规则
tags:
  - routing
  - user-report
match:
  keywords:
    - 用户
    - 会员
    - 活跃用户
    - 会员复购
    - 用户报表
---

# 用户运营深度报告路由

判断为用户运营取数路径时，只允许使用 `qdm-cmr-cli`。

CMR CLI 参数格式、时间过滤、`--ai` 白名单和失败重试规则以 `spec/common/cmr-cli-readme.md` 与 `spec/common/time-policy.md` 为准。

默认全国场景下，`overview` 是唯一必需模块。`overview` 成功后，必须先执行：

```bash
bin/data-harness-cli inject-template
```

`overview` 成功取数后，下一步必须立即执行该 template 注入命令；template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。

只有在该 template 注入命令成功且后续收到 template 二阶段注入后，才允许生成最终报告正文；template 注入后只注入 selected playbook 绑定的 template 正文，不再注入 spec、routing 或 playbook。template 注入前不读取、不使用 template。

推荐命令族：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report user overview <time_filter> --area-type 管理区域 --area CN00 --ai

bin/data-harness-cli inject-template
```

可选补充命令：

```bash
"$QDM_CMR_CLI" report user inspect <time_filter> --area-type 管理区域 --area CN00
"$QDM_CMR_CLI" report user tree --values <time_filter> --area-type 管理区域 --area CN00
"$QDM_CMR_CLI" table --report user <time_filter> --area-type 管理区域 --area CN00 --indicator 活跃用户数 --dim-type 管理区域 --ai
```

查询策略：

- 必须查询 `report user overview --ai`。
- 默认全国场景不主动拆分为多个独立模块。
- 不传 `--category-type` 或 `--category`。
- 只有在用户指定非全国区域、`overview` 口径异常、区域子指标明细不足或需要校验图谱时，才允许补充 `inspect`、`tree --values` 或 `table`。
- `bin/data-harness-cli inject-template` 不并行，必须在 `overview` 成功后的下一步立即执行。
- `overview` 成功后、template 注入前，不得先整理证据、总结素材、生成中间分析或输出阶段性结论。
- 对 CLI 未返回的数据，不得自行估算。

禁止路由：

- 禁止把用户运营报告路由到 `qdm-indicators-cli`。
- 禁止为用户运营报告传入品类过滤或生成品类下钻分析。
- 禁止用本地静态示例值替代 CLI 返回值。
