# QDM CLI 路由规则

该文件保留为兼容入口。运行时 hook 不再把本文件完整注入给 Agent，而是按命中的 `report_name` 只注入一个精准路由文件。

| query_type | report_name | routing file |
|---|---|---|
| `business_overview` | `business-overview` | `routing/business-overview.md` |
| `store_overview` | `store-overview` | `routing/store-overview.md` |
| `member_overview` | `member-overview` | `routing/member-overview.md` |
| `financial_overview` | `financial-overview` | `routing/financial-overview.md` |

公共约束见 `routing/index.md`。具体执行规则以命中的单 report 路由文件为准。
