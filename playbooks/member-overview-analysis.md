# 用户运营深度报告 Playbook

## 目标

把“昨天的用户报表”“用户运营情况”“会员表现怎么样”等用户/会员运营类问题输出为一份结构稳定、证据可追溯、可行动的用户运营深度报告。

分析主线固定为：

1. 用户规模与分层结构
2. 会员价值与复购转化
3. 用户触达与渠道效率

本 playbook 负责定义取数流程、必要证据和报告生成约束；最终报告版式、章节顺序和表格结构在 signal 后由二阶段注入的 template 决定。

## 适用边界

适用于用户询问用户报表、用户运营、会员运营、会员表现、活跃用户、会员复购、用户触达、休眠/流失用户等问题。

不适用于：

- 泛问经营概览、销售经营分析、品效或供应链整体分析。
- 门店管理、门店规模、门店利润或门店运营效率分析。
- 单个指标定义解释。
- 用户明确要求走指标平台、指标口径或非 CMR 报表的问题。

命中该 playbook 后，不向用户追问；若用户未给时间，默认使用昨天；若用户未给区域，默认使用全国（不含港澳）；用户报表不支持品类过滤，品类口径按报表默认全口径处理。

## 输入与口径确认

执行查询前先归一化以下口径：

- 时间口径：支持日期、周、月；“昨天”使用 `<time_filter>`。
- 区域口径：区域支持下钻。未指定区域时使用 `--area-type 管理区域 --area CN00`，即全国（不含港澳）。
- 品类口径：用户报表不支持品类过滤，不传 `--category-type` 和 `--category`。用户表达“全品类”时，在报告中表述为用户报表默认全口径，不把品类参数传给 CLI。
- 报告范围：从 `overview` 或必要时 `inspect` 返回结果中确认 report、时间、区域解析结果。

“昨天的用户报表（全国、全品类维度）”在 2026-05-22 执行时，对应 CLI 过滤条件为：

```bash
--date 2026-05-21 --area-type 管理区域 --area CN00
```

不得追加：

```bash
--category-type 大分类 --category 00
```

实测用户报表追加品类过滤会失败：

```text
error: report 用户报表 does not support category filters
```

## 查询原则

默认全国口径下，`qdm-cmr-cli report user overview <time_filter> --ai` 是唯一必需查询。源头支持 `--ai`，会返回 compact 的 `#section/#cols/#data` 结构，包含 `indicators`、`area`、`category`、`trend`。其中 `category` 在用户报表下通常为空，不作为品类分析依据。`overview` 成功后，下一步必须立即执行 `before-report-signal.py member-overview`。

Agent 不应在默认全国用户报表场景下主动拆开调用 `indicators`、`area`、`category`、`trend` 或 `table`。只有在以下情况才允许补充探索：

- 用户指定了非全国区域，需要确认该区域下的可用下钻证据。
- `overview --ai` 返回缺失、为空或口径异常。
- 需要读取完整 `filters` JSON 来确认 report/time/area。
- 需要展示或校验报表图谱父子关系、确认某些模板指标是否有值。
- 需要区域维度子指标明细，而 `overview.area` 只能提供当前一级指标分布。

## 推荐查询方式

CMR CLI 参数格式、时间过滤、`--ai` 白名单和失败重试规则以 `spec/cmr-cli-readme.md` 与 `spec/qdm-time-policy.md` 为准。

使用 `qdm-cmr-cli report user overview --ai` 作为用户报表主取数入口。该命令一次返回核心指标、区域分布和近 30 天趋势；对“昨天的用户报表（全国、全品类维度）”这类报告，已经可以覆盖大部分可用指标值、同比、环比、区域和趋势基础证据。

默认推荐命令：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report user overview <time_filter> --ai
```

全国默认示例：

```bash
"$QDM_CMR_CLI" report user overview \
  --date 2026-05-21 \
  --area-type 管理区域 \
  --area CN00 \
  --ai
```

只有需要完整 JSON 结构或 `filters` 字段时，才执行 `inspect` 或非 `--ai` 版本：

```bash
"$QDM_CMR_CLI" report user inspect <time_filter>
"$QDM_CMR_CLI" report user overview <time_filter>
```

若需要切换区域和趋势对应的指标，仍优先使用 `overview` 并指定 `--indicator`；`indicators` 仍返回全量核心指标，`area` 和 `trend` 会切换到对应指标：

```bash
"$QDM_CMR_CLI" report user overview <time_filter> --indicator 活跃用户数 --ai
"$QDM_CMR_CLI" report user overview <time_filter> --indicator 会员销售占比 --ai
```

## 可选校验与补充

仅在 `overview` 不够时补充独立模块：

- 需要确认过滤条件解析时，用 `inspect`。
- 需要展示或校验报表图谱父子关系、判断模板指标是否配置但无值时，用 `tree --values`。
- 需要区域维度子指标明细时，用 `table`。

```bash
"$QDM_CMR_CLI" report user inspect <time_filter>
"$QDM_CMR_CLI" report user tree --values <time_filter>
"$QDM_CMR_CLI" table --report user <time_filter> --indicator 活跃用户数 --dim-type 管理区域 --ai
"$QDM_CMR_CLI" table --report user <time_filter> --indicator 会员销售占比 --dim-type 管理区域 --ai
```

`tree --values` 当前不支持 `--ai`，保持默认 JSON 输出。它用于确认指标树、指标归属和哪些指标有值，不替代 `overview --ai`。

`table --ai` 用于补充区域明细；若某个指标在 `overview` 和 `tree --values` 中没有值，`table` 返回 0 或空时不得把 0 当作报告事实使用，除非业务口径明确表示该值真实为 0。

除非有明确的结构校验或明细下钻需求，不需要把 `overview` 拆成 `indicators`、`area`、`trend` 多次查询。

## 品类规则

用户报表不支持品类过滤，也不输出可用的品类维度数据。实测：

- 带 `--category-type 大分类 --category 00` 会直接报错。
- `overview --ai` 返回的 `category` section 为空结构。

因此生成用户运营报告时：

- 不调用品类维度进行分析。
- 不生成品类排名、品类拖累或品类贡献。
- 用户要求“全品类”时，报告口径写为“用户报表默认全口径”，不得伪造为已传入品类筛选。

## 指标树与取数映射

### 用户规模与分层结构

核心路径：

```text
活跃用户数 -> 新消费用户数、普通活跃会员数、各等级 VIP 活跃会员数、休眠期会员数、流失期用户数、可触达用户数 -> 新客/各等级会员客单价、留存率/用户挽回率
```

指标映射：

| 指标 | code | 主要来源 | 用途 |
| :--- | :--- | :--- | :--- |
| 活跃用户数 | `activeMemberNum` | `overview.indicators` | 一级核心指标，衡量用户整体规模 |
| 新消费用户数 | `firstTranMemberNum` | `overview.indicators` | 判断新客获取能力 |
| 新客首单客单价 | `firstTranMemberPerCustAmt` | `overview.indicators` | 判断新客首单消费质量 |
| 次月留存率 | `nextMonthRetainedRate` | `tree --values` 校验，若无值则省略 | 判断新客留存质量 |
| 普通活跃会员数 | `regularActiveMemberNum` | `overview.indicators` | 判断基础会员规模 |
| 普通活跃会员消费频次 | `regularActiveMemberTranTimes` | `overview.indicators` | 判断基础会员消费深度 |
| 普通活跃会员客单价 | `regularActiveMemberPerCustAmt` | `overview.indicators` | 判断基础会员消费价值 |
| vip1活跃会员数 | `vip1ActiveMemberNum` | `overview.indicators` | 判断低等级 VIP 规模 |
| vip1活跃会员消费频次 | `vip1ActiveMemberTranTimes` | `overview.indicators` | 判断低等级 VIP 消费深度 |
| vip1活跃会员客单价 | `vip1ActiveMemberPerCustAmt` | `overview.indicators` | 判断低等级 VIP 消费价值 |
| vip2活跃会员数 | `vip2ActiveMemberNum` | `overview.indicators` | 判断中等级 VIP 规模 |
| vip2活跃会员消费频次 | `vip2ActiveMemberTranTimes` | `overview.indicators` | 判断中等级 VIP 消费深度 |
| vip2活跃会员客单价 | `vip2ActiveMemberPerCustAmt` | `overview.indicators` | 判断中等级 VIP 消费价值 |
| vip3活跃会员数 | `vip3ActiveMemberNum` | `overview.indicators` | 判断高等级 VIP 规模 |
| vip3活跃会员消费频次 | `vip3ActiveMemberTranTimes` | `overview.indicators` | 判断高等级 VIP 消费深度 |
| vip3活跃会员客单价 | `vip3ActiveMemberPerCustAmt` | `overview.indicators` | 判断高等级 VIP 消费价值 |
| 休眠期会员数 | `dormantMemberNum` | `overview.indicators` | 判断会员活跃衰退风险 |
| 用户挽回率 | `winbackMemberRate` | `tree --values` 校验，若无值则省略 | 判断休眠/流失用户召回能力 |
| 流失期用户数 | `churnedMemberNum` | `overview.indicators` | 判断用户流失压力 |
| 可触达用户数 | `reachMemberNum` | `overview.indicators` | 判断可运营用户基础池 |

### 会员价值与复购转化

核心路径：

```text
会员复购率/会员销售占比 -> 复购会员数、消费会员数、交叉会员数 -> 复购会员消费频次、线上/线下消费会员数
```

指标映射：

| 指标 | code | 主要来源 | 用途 |
| :--- | :--- | :--- | :--- |
| 会员复购率 | `memberRepurchaseNoDifferenceRate` | `tree --values` 校验，若无值则省略 | 一级核心指标，衡量会员复购粘性 |
| 复购会员数 | `repurchaseMemberNum` | `tree --values` 校验，若无值则省略 | 判断复购用户基数 |
| 消费会员数 | `buyMemberNum` | `overview.indicators` | 判断会员消费基础盘 |
| 复购会员消费频次 | `memberRepurchaseTranTimes` | `tree --values` 校验，若无值则省略 | 判断复购深度 |
| 会员销售占比 | `memberSaleAmtRate` | `overview.indicators` | 一级核心指标，衡量会员销售贡献 |
| 交叉会员数 | `crossMemberNum` | `overview.indicators` | 判断跨渠道消费行为 |
| 线下消费会员数 | `offlineMemberNum` | `overview.indicators` | 判断线下会员消费活跃度 |
| 线上消费会员数 | `onlineMemberNum` | `overview.indicators` | 判断线上会员消费活跃度 |

### 用户触达与渠道效率

核心路径：

```text
可触达用户数 -> 会员数、社群用户数、官媒用户数、抖音用户数 -> 各渠道用户规模与增长表现
```

指标映射：

| 指标 | code | 主要来源 | 用途 |
| :--- | :--- | :--- | :--- |
| 可触达用户数 | `reachMemberNum` | `overview.indicators` | 一级触达基础指标 |
| 会员数 | `memberNum` | `overview.indicators` | 判断会员基础池规模 |
| 社群用户数 | `communityUserNum` | `overview.indicators` | 判断私域触达能力 |
| 官媒用户数 | `officialMediaUserNum` | `tree --values` 校验，若无值则省略 | 判断官方媒体触达基础 |
| 抖音用户数 | `douyinUserNum` | `tree --values` 校验，若无值则省略 | 判断内容平台触达基础 |

## 2026-05-21 全国口径实测说明

以下实测只用于验证 CLI 行为和 playbook 可行性，不得在其他日期报告中复用。

可用主命令：

```bash
"$QDM_CMR_CLI" report user overview --date 2026-05-21 --area-type 管理区域 --area CN00 --ai
```

实测返回：

- `indicators` 有值，覆盖活跃用户数、会员销售占比、消费会员数、线上/线下消费会员数、交叉会员数、会员数、社群用户数、休眠/流失、新客、VIP 分层等。
- `area` 有值，默认对应活跃用户数的管理区域分布。
- `trend` 有值，默认对应活跃用户数近 30 天趋势。
- `category` 为空。
- `tree --values` 可看到会员复购率、次月留存率、用户挽回率、官媒用户数、抖音用户数等指标配置，但本次没有返回指标值。

## 区域和趋势证据

区域支持下钻，优先使用 `overview` 的 `area` section。默认 `overview.area` 对应当前指标，若未指定 `--indicator`，通常为活跃用户数。

需要切换区域和趋势对应的指标时，在 `overview` 上指定 `--indicator`：

```bash
"$QDM_CMR_CLI" report user overview <time_filter> --indicator 活跃用户数 --ai
"$QDM_CMR_CLI" report user overview <time_filter> --indicator 会员销售占比 --ai
```

趋势支持近 30 天对比，来自 `overview` 的 `trend` section。趋势只能用于判断该指标的短期波动、持续变化或异常峰谷，不得推断未返回指标的趋势。

## 证据优先级

1. `overview.indicators` 确认当前值、同比、环比、阈值、单位和指标 code。
2. `overview.area` 和 `overview.trend` 提供区域与趋势证据。
3. `inspect` 仅用于确认 report/time/area 解析。
4. `tree --values` 仅用于需要校验图谱父子关系、指标归属或指标是否有值的场景。
5. `table --ai` 仅用于区域维度子指标明细，不替代 `overview`。

若同一指标在不同模块口径冲突，优先以 `overview.indicators` 为准；其他模块只做结构性佐证。

## 报告模板

最终报告必须使用 signal 后二阶段注入的 template。signal 前不读取、不打开、不猜测、不使用 template。

模板使用规则：

- `overview` 成功取数后，下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py member-overview`。
- `overview` 成功后、signal 前，禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 保持 signal 后 template 章节顺序，不自行增删一级章节。
- signal 后 template 中的指标组和表格结构优先级高于自由组织。
- 第一章数据来源写为 `qdm-cmr-cli report user <modules>`；不要写成 `report member`。
- 区域口径未指定时填全国（不含港澳）。
- 品类口径写为用户报表默认全口径；不要声称 CLI 已传入全品类过滤。
- CLI 未返回的指标行、指标组或段落直接省略；不写“暂无数据”“未返回”等缺失说明，除非用户明确要求解释数据缺失。
- 不把 signal 后 template 中的占位符原样留在最终报告中。
- 最终报告正文只使用已查询到的 CLI 证据，不使用 `templates/member-demo.md` 示例值或经验估算值。

signal 后 template 与证据映射：

- 第一章：来自 `overview` 或 `inspect`，补充时间口径、区域口径、品类口径、数据来源和总体判断。
- 第二章：来自 `overview.indicators` 和必要时 `tree --values`，只展示有值的一级核心指标。若会员复购率没有值，则从核心总览表中省略。
- 第三章：填充活跃用户数、新客、VIP 分层、休眠/流失、可触达等用户规模与分层结构指标。
- 第四章：填充会员销售占比、消费会员数、交叉会员数、线上/线下消费会员数，以及有值的复购相关指标。
- 第五章：填充可触达用户数、会员数、社群用户数，以及有值的官媒/抖音指标。
- 第六章：把前三个维度的核心问题整理为“现象 -> 影响 -> 推断”。
- 第七章：给出与第六章问题一一对应的短期动作和长期动作。
- 第八章：只列已由 CLI 证据支持的风险和后续跟踪指标。
- 第九章：保留模板内可被当前报告使用的指标定义；未涉及指标可省略。

## 证据规则

- 数值、排名、同比、环比、阈值、异常点必须来自 CLI 输出。
- 推断必须可追溯到至少一条已返回数据。
- 指标配置存在但没有值，不等于指标值为 0。
- `table` 返回 0 或空时，需要结合 `overview` 和 `tree --values` 判断是否为无值，不得直接把无值写成 0。
- 不确定时使用“可能”“倾向于”，并说明证据边界。
- 不允许把通用业务常识写成已发生事实。

## 异常处理

- 若 `overview --ai` 查询失败，先检查是否误传了品类参数；用户报表必须移除 `--category-type` 和 `--category` 后重试。
- 若区域参数解析失败，先用 `search stores --type 管理区域 --keyword <keyword> --ai` 找到区域编码，再重试。
- 若 `overview --ai` 成功但 `category` 为空，视为正常，不补查品类。
- 若 `overview --ai` 成功但部分指标没有值，按 signal 后 template 规则省略，不补造缺失指标。
- 若 `overview --ai` 成功，不得在 signal 前总结、整理报告素材、生成中间分析或输出阶段性结论。
- 若用户中途追加更具体的筛选条件，应按新条件重新确认时间和过滤口径，并重新完成必要查询。

## 最终输出检查

输出前逐项检查：

- 已完成 `report user overview <time_filter> --ai`。
- 已在 `overview` 成功后的下一步立即执行 `python3 .claude/hooks/before-report-signal.py member-overview`，且 signal 前没有输出总结、素材整理或中间分析。
- 已收到 template 二阶段注入。
- 未向用户报表传入 `--category-type` 或 `--category`。
- 报告使用 signal 后 template 的章节结构。
- 数据来源写的是 `qdm-cmr-cli report user <modules>`。
- 第二章只展示 CLI 返回有值的一级核心指标。
- 第三章只放用户规模与分层结构指标。
- 第四章只放会员价值与复购转化指标。
- 第五章只放用户触达与渠道效率指标。
- 没有输出品类下钻、品类排名、品类拖累或品类贡献。
- 所有数值和诊断事实都能回溯到 CLI 输出。
- 没有遗留模板占位符、示例值或未返回指标。
