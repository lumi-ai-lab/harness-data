---
id: playbook-financial-default-overview
kind: playbook
domain: financial
title: 财务核心指标默认取数 Playbook
tags:
  - playbook
  - financial-report
match:
  keywords:
    - 财务报表
    - 财务核心指标
    - 公司报表
---

# 财务核心指标深度报告 Playbook

## 目标

把“财务报表”“公司财务情况”“EBITDA 表现”等财务/公司报表类问题输出为一份结构稳定、证据可追溯、可行动的财务核心指标深度报告。

分析主线固定为：

1. 盈利核心指标
2. 收入结构与毛利贡献
3. 费用管控与成本效率

最终报告版式、章节顺序和表格结构在 signal 后由二阶段注入的 template 决定。

## 适用边界

适用于用户询问财务报表、公司报表、公司财务情况、盈利情况、EBITDA、营业收入、毛利额、费用率/额等问题。

不适用于：

- 泛问经营概览、销售经营分析、品效或供应链整体分析，且未表达财务/公司报表诉求的问题。
- 门店管理、用户运营等其他单一报表问题。
- 单个指标定义解释。
- 用户明确要求走指标平台、指标口径或非 CMR 报表的问题。

命中该 playbook 后，不向用户追问。公司/财务报表只支持周、月时间粒度；若用户未给时间，默认使用昨天所在周；若用户未给区域，不强制追加区域过滤；品类维度不可选，固定为全品类。

## 输入与口径确认

执行查询前先归一化以下口径：

- 时间口径：只支持周、月。用户输入昨天、今天或具体日期时，先解析该日期，再转换为所在 QDM 业务周，使用 `--week YYYY-NN`；不得使用 `--date`。
- 区域口径：区域维度可选。用户未指定区域时不强制追加 `--area-type` 或 `--area`，按 CLI 默认全国口径执行。
- 品类口径：品类维度不可选，默认全品类；不得传入 `--category-type` 或 `--category`。
- 报告范围：从 `tree --values.filters`、`table.meta` 或必要时 `inspect` 返回结果中确认 report、时间、区域、品类解析结果。

“昨天的财务报表”在 2026-05-22 执行时，“昨天”为 2026-05-21，应先用 `search weeks` 确认该日期所在 QDM 业务周；若返回 value 为 `2026-20`，CLI 过滤条件为：

```bash
--week 2026-20
```

最终报告概述必须明确说明：用户询问的是 2026-05-21，但公司/财务报表不支持日维度，已按对应 QDM 业务周口径统计。

## 查询原则

默认全品类口径下，财务报告必须完成三个必需取数动作：

- `qdm-cmr-cli report company indicators <time_filter> --ai`
- `qdm-cmr-cli report company tree --values <time_filter>`
- `qdm-cmr-cli table --report company <time_filter> --indicator EBITDA --dim-type 管理区域 --ai`

三个动作都成功后，下一步必须立即执行 `before-report-signal.py financial-overview`。

实测结论：

- `indicators --ai` 支持 AI 压缩输出，能提供可用指标的当前值、同比、环比、单位和阈值，是同比/环比的主要来源。
- `tree --values` 不追加 `--ai`，能提供 EBITDA 财务指标树、指标 code、父子关系、subIndicator 和部分节点当前值，是模板指标归属与缺失判断的主要来源。
- `table --report company --indicator EBITDA --dim-type 管理区域 --ai` 支持 AI 压缩输出，能一次返回 EBITDA 树下收入、毛利、费用结构当前值，是结构拆解的主要来源。
- `overview --ai` 实测返回的 `indicators` 与 `report company indicators --ai` 相近，但 `area/category` 默认为空、`trend` 默认全 0，且无法完整补齐模板所需财务树，因此不作为默认必需模块。
- `report company area --ai`、`category --ai` 在默认 EBITDA 指标下返回空；`trend --ai` 在默认 EBITDA 指标下返回全 0。
- `table --report company --indicator 公司营业收入|公司毛利额|费率 --dim-type 管理区域 --ai` 实测返回空；表格下钻应挂根指标 `EBITDA`。

Agent 不应在默认全国全品类场景下把 `overview`、`area`、`category`、`trend` 当作必需模块。只有在以下情况才允许补充探索：

- 用户指定了区域，需要确认可用下钻证据。
- 必需模块返回缺失、为空或口径异常。
- 需要读取完整 `filters` JSON 来确认 report/time/area/category。
- 用户明确要求区域、品类或趋势下钻，且必需模块不足以支撑判断。

## 推荐查询方式

CMR CLI 参数格式、时间过滤、`--ai` 白名单和失败重试规则以 `spec/common/cmr-cli-readme.md` 与 `spec/common/time-policy.md` 为准。

默认推荐命令：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report company indicators <time_filter> --ai
"$QDM_CMR_CLI" report company tree --values <time_filter>
"$QDM_CMR_CLI" table --report company <time_filter> --indicator EBITDA --dim-type 管理区域 --ai
```

周口径示例：

```bash
"$QDM_CMR_CLI" report company indicators \
  --week 2026-20 \
  --ai
"$QDM_CMR_CLI" report company tree --values \
  --week 2026-20
"$QDM_CMR_CLI" table --report company \
  --week 2026-20 \
  --indicator EBITDA \
  --dim-type 管理区域 \
  --ai
```

三个命令没有业务顺序依赖，可并行执行。`tree --values` 当前不支持 `--ai`，保持默认 JSON 输出。

## 可选校验与补充

仅在必需取数不够时补充独立模块：

- 需要确认过滤条件解析时，用 `inspect`。
- 需要完整 `overview` 结构时，可补充 `overview --ai` 或非 AI 版本，但不得替代三个必需动作。
- 用户指定区域时，在三个必需命令中追加对应 `--area-type <type> --area <area>`。
- 需要 backend 原始包时，用 `table --report company <time_filter> --indicator EBITDA --dim-type 管理区域 --full`，但常规报告优先使用 `--ai`。

```bash
"$QDM_CMR_CLI" report company inspect <time_filter>
"$QDM_CMR_CLI" report company overview <time_filter> --ai
"$QDM_CMR_CLI" table --report company <time_filter> --indicator EBITDA --dim-type 管理区域 --full
```

## 指标树与取数映射

### 盈利核心指标

核心路径：

```text
EBITDA -> 公司营业收入、公司毛利额、费率/额
```

指标映射：

| 指标 | code | 主要来源 | 用途 |
| :--- | :--- | :--- | :--- |
| EBITDA | `ebitdaCompanyProfit` | `table EBITDA 管理区域 --ai`、`tree --values` | 总纲指标，衡量核心盈利和现金流创造能力；若 table 返回 0 且 tree 未返回真实值，报告中不得自行倒算。 |
| 公司营业收入 | `companyBusinessIncome` | `indicators --ai` 获取同比/环比，`table EBITDA 管理区域 --ai` 获取结构当前值 | 收入规模 |
| 公司毛利额 | `companyProfit` | `table EBITDA 管理区域 --ai`、`tree --values` | 盈利基础；若返回 0/空，按 CLI 事实展示或省略，不自行汇总。 |
| 费率 | `companyTotalFeeRate` | `table EBITDA 管理区域 --ai`、`tree --values` | 费用管控效率 |
| 额 | `companyTotalFee` | `tree --values` 的 subIndicator 或补充来源 | 费用规模；若未返回金额值则只展示费率。 |

### 收入结构与毛利贡献

核心路径：

```text
公司营业收入 -> 供应链收入、直营店收入、品牌管理&加盟费、其他业务收支净额
公司毛利额 -> 供应链毛利额、直营店毛利额
```

指标映射：

| 指标 | code | 主要来源 | 用途 |
| :--- | :--- | :--- | :--- |
| 供应链收入 | `financeScmIncome` | `indicators --ai`、`table EBITDA 管理区域 --ai`、`tree --values` | 核心供应链收入贡献 |
| 直营店收入 | `directStoreIncome` | `table EBITDA 管理区域 --ai`、`tree --values` | 直营店收入贡献 |
| 品牌管理&加盟费 | `manageFranchiseFee` | `table EBITDA 管理区域 --ai`、`tree --values` | 加盟与品牌管理收入贡献 |
| 其他业务收支净额 | `otherBusinessProfit` | `table EBITDA 管理区域 --ai`、`tree --values` | 其他业务净贡献 |
| 供应链毛利额 | `financeScmProfit` | `indicators --ai`、`table EBITDA 管理区域 --ai`、`tree --values` | 供应链毛利贡献 |
| 直营店毛利额 | `directStoreProfitAmt` | `indicators --ai`、`table EBITDA 管理区域 --ai`、`tree --values` | 直营店毛利贡献 |

### 费用管控与成本效率

核心路径：

```text
费率/额 -> 宣传促销补贴费率/额、运输费率/额、租金费率/额、人员费用率/额、其他费用率/额 -> 宣传促销费率/额、补贴费用率/额
```

指标映射：

| 指标 | code | 主要来源 | 用途 |
| :--- | :--- | :--- | :--- |
| 宣传促销补贴费率 | `companyPromotionAllowanceFeeRate` | `table EBITDA 管理区域 --ai`、`tree --values` | 市场投入与补贴合计费率 |
| 宣传促销补贴费 | `companyPromotionAllowanceFee` | `tree --values` 的 subIndicator 或补充来源 | 市场投入与补贴合计金额；若未返回金额值则只展示费率。 |
| 宣传促销费率 | `companyPromotionFeeRate` | `tree --values` | 宣传促销费率；若无值则省略。 |
| 宣传促销费 | `companyPromotionFee` | `tree --values` 的 subIndicator 或补充来源 | 宣传促销金额；若无值则省略。 |
| 补贴费用率 | `companyAllowanceFeeRate` | `tree --values` | 补贴费用率；若无值则省略。 |
| 补贴费用 | `companyAllowanceFee` | `tree --values` 的 subIndicator 或补充来源 | 补贴金额；若无值则省略。 |
| 运输费率 | `companyLogisticsFeeRate` | `tree --values` | 物流运输费用效率；若无值则省略。 |
| 运输费 | `companyLogisticsFee` | `tree --values` 的 subIndicator 或补充来源 | 物流运输费用金额；若无值则省略。 |
| 租金费率 | `companyRentFeeRate` | `tree --values` | 租金成本效率；若无值则省略。 |
| 租金费 | `companyRentFee` | `tree --values` 的 subIndicator 或补充来源 | 租金费用金额；若无值则省略。 |
| 人员费用率 | `companyStaffFeeRate` | `tree --values` | 人力成本效率；若无值则省略。 |
| 人员费用 | `companyStaffFee` | `tree --values` 的 subIndicator 或补充来源 | 人力成本金额；若无值则省略。 |
| 其他费用率 | `companyOtherFeeRate` | `tree --values` | 其他费用效率；若无值则省略。 |
| 其他费用 | `companyOtherFee` | `indicators --ai`、`tree --values` | 其他费用金额 |

## 证据优先级

1. `indicators --ai` 确认可用指标的当前值、同比、环比、阈值、单位和指标 code。
2. `table --report company --indicator EBITDA --dim-type 管理区域 --ai` 确认 EBITDA 树下各指标当前值和区域结构。
3. `tree --values` 确认指标树父子关系、subIndicator 和哪些模板指标配置但无值。
4. `inspect` 或非 AI 输出仅用于口径异常排查。
5. `overview/area/category/trend` 默认不作为财务报告证据主来源。

## 报告生成约束

- `indicators --ai`、`tree --values`、`table EBITDA 管理区域 --ai` 三个必需取数动作全部成功后，下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py financial-overview`。
- 三个必需取数动作成功后、signal 前，禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- signal 前不读取、不打开、不猜测、不使用 template。
- 最终报告必须使用 signal 后二阶段注入的 template。
- 章节顺序保持 signal 后 template 的结构。
- 报告中的所有数值、同比、环比、排名、阈值和诊断事实必须来自 CLI 输出。

## 当前 Harness 支持评估

现有 Harness 已具备财务报告接入所需的基础能力：

- UserPromptSubmit 阶段可按意图注入单 report 的 intent、routing、spec、playbook。
- PostToolUse 由 `data-harness-cli posttool --format claude-hook` 处理：记录指定 report 的必需取数模块，并在 signal 后只注入匹配 template。
- `qdm-cmr-cli report company` 已暴露公司报表入口，支持 `overview`、`inspect`、`tree`、`indicators`、`area`、`category`、`trend` 等模块。
- `qdm-cmr-cli table --report company` 已暴露公司报表表格入口，`--indicator EBITDA --dim-type 管理区域 --ai` 可返回 EBITDA 树下结构当前值。

仍需完成或持续确认的工作：

- 已新增 `financial_overview` 意图识别，并确保优先级高于泛经营分析。
- 已在 report 配置中新增 `financial-overview -> company`，必需动作为 `indicators`、`tree`、`table`，template 为 `templates/financial-overview-report.md`。
- 已新增 `spec/financial/report-contract.md`，明确 EBITDA、收入、毛利、费用指标的章节归属和禁放规则。
- 已新增 Go 测试覆盖：用户 prompt 注入、company indicators/tree/table 模块记录、signal 后财务模板注入、未取数 signal 的缺失模块提示。
- 数据侧仍需确认部分指标真实值口径：当前实测 EBITDA、公司毛利额、供应链收入/毛利额等在部分接口中返回 0 或缺失；报告生成时必须按 CLI 返回展示或省略，不得倒算。
