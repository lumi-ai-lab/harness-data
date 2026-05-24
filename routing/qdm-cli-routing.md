---
id: routing-qdm-cli
kind: routing
domain: common
title: QDM CLI 路由规则
tags:
  - routing
  - cli
match:
  keywords:
    - qdm
    - cli
    - indicators
---

# QDM CLI 路由规则

该文件保留为兼容入口。运行时 hook 不再把本文件完整注入给 Agent，也不输出 `query_type`；上下文由 `data-harness-cli context` 按关键词和 frontmatter 召回。

| report intent | playbook | routing file |
|---|---|---|
| 经营分析 | `playbooks/business/default-overview.md` | `routing/business-overview.md` |
| 门店管理 | `playbooks/store/default-overview.md` | `routing/store-overview.md` |
| 用户运营 | `playbooks/member/default-overview.md` | `routing/member-overview.md` |
| 财务核心指标 | `playbooks/financial/default-overview.md` | `routing/financial-overview.md` |

公共约束见 `routing/index.md`。具体执行规则以命中的单 report 路由文件为准。
