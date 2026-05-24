# QDM 运行约束数据

本目录存放 QDM 助手在用户提交提示词时使用的运行约束规格说明。当前版本覆盖泛经营概览类问题、门店管理类问题、用户运营类问题和财务核心指标类问题，例如“查看昨天的经营情况”“昨天的门店管理情况”“查看昨天用户情况”“查看昨天的财务报表”，并将其稳定转换为固定结构的深度分析报告。

运行时行为由 `/Users/pengmd/c/qdm/harness-data/.claude/hooks/qdm-harness-context.py` 实现。

Claude Code 必须以 `/Users/pengmd/c/qdm/harness-data` 作为项目目录启动，这样 `.claude/settings.json` 中的项目级钩子才会被加载。

CLI 绝对路径集中配置在 `config/qdm-cli-paths.env`。

## 目录结构

- `intents/`：意图契约与槽位归一化规则。
- `routing/`：CLI 路由规则。
- `playbooks/`：分析流程与必要证据来源。
- `spec/`：报告指标归属和业务知识权威说明。
- `templates/`：报告骨架与输出约束。

## 最小可用版本边界

- 覆盖泛经营概览类问题、门店管理类问题、用户运营类问题和财务核心指标类问题。
- 命中该意图后，智能体必须使用 `qdm-cmr-cli`。
- 报告结构固定，具体数值必须来自 CLI 输出。
- template 只在 signal 后二阶段注入；signal 前不需要读取或使用 template。
- 经营分析六个必需模块可并行取数；spec 在取数前注入；全部成功后的下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py business-overview`，收到 template 二阶段注入后再输出最终报告。
- 门店管理默认只要求 `report store overview --ai`；spec 在取数前注入；成功后的下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py store-overview`，收到 template 二阶段注入后再输出最终报告。
- 用户运营默认只要求 `report user overview --ai`；spec 在取数前注入；成功后的下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py member-overview`，收到 template 二阶段注入后再输出最终报告；用户报表不支持品类过滤。
- 财务核心指标默认要求 `report company indicators --ai`、`report company tree --values`、`table --report company --indicator EBITDA --dim-type 管理区域 --ai` 三个必需取数动作；company 报表只支持周/月，日维度问题转换为所在周；品类不可选且不传品类过滤；区域可选。spec 在取数前注入；全部成功后的下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py financial-overview`，收到 template 二阶段注入后再输出最终报告。
- 必需取数完成后、signal 前，禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 缺失值应直接省略，不要单独列出。

## 运行约束处理流程示例：“昨天的经营情况”

下面以用户提示词 `昨天的经营情况` 为例，用 ASCII 图说明当前运行约束从用户输入到最终报告的完整处理链路。

### 1. 总体流程图

```text
+--------------------------+
| 用户输入                 |
| "昨天的经营情况"         |
+------------+-------------+
             |
             v
+--------------------------+
| Claude Code              |
| 触发 UserPromptSubmit    |
| 配置文件:                |
| .claude/settings.json    |
+------------+-------------+
             |
             v
+--------------------------+
| Hook 脚本                 |
| .claude/hooks/           |
| qdm-harness-context.py   |
|                          |
| 1. 读取 prompt           |
| 2. 判断是否命中意图      |
| 3. 解析时间              |
| 4. 拼接约束上下文        |
+------------+-------------+
             |
             v
+--------------------------+
| additionalContext        |
| 注入给 Claude Code       |
|                          |
| 包含:                    |
| - 时间过滤条件           |
| - 意图规则               |
| - 命中的单 report 路由   |
| - 命中的单 report spec   |
| - 分析 playbook          |
| 不包含:                  |
| - 其他 report 路由       |
| - 报告 template          |
+------------+-------------+
             |
             v
+--------------------------+
| Claude 执行报告任务      |
|                          |
| 1. 读取 CLI 路径配置     |
| 2. 调用 qdm-cmr-cli      |
| 3. 立即执行 before-report|
|    signal                |
| 4. 收到 template         |
| 5. 按模板输出 1-9 章     |
+--------------------------+
```

### 2. 文件职责图

```text
harness-data/
|
+-- .claude/settings.json
|   |
|   +-- 作用:
|       注册 Claude Code 的 UserPromptSubmit 钩子。
|       用户每次提交提示词时，都会执行下面这个脚本:
|       python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/qdm-harness-context.py"
|
+-- .claude/hooks/qdm-harness-context.py
|   |
|   +-- 作用:
|       当前运行约束的入口脚本。
|       它负责读取用户提示词、识别经营概览意图、解析时间、
|       读取 intent、命中的单 report 路由和 playbook，
|       并把轻量取数上下文返回给 Claude Code。
|
+-- .claude/hooks/qdm-business-report-posttool.py
|   |
|   +-- 作用:
|       监听 Bash 命令，记录已完成的 CLI 模块。
|       before-report-signal 满足门禁后，二阶段注入 template。
|
+-- config/qdm-cli-paths.env
|   |
|   +-- 作用:
|       集中维护 CLI 绝对路径。
|       经营概览报告必须使用其中的 QDM_CMR_CLI。
|
+-- intents/business-overview.md
|   |
|   +-- 作用:
|       定义什么样的用户问题算 business_overview。
|       也定义固定意图字段、时间解析原则和非命中边界。
|
+-- routing/business-overview.md
|   |
|   +-- 作用:
|       定义命中 business_overview 后应该走哪个 CLI。
|       当前规则强制使用 qdm-cmr-cli，
|       禁止把泛经营概览路由到 qdm-indicators-cli。
|
+-- playbooks/business-overview-analysis.md
|   |
|   +-- 作用:
|       定义分析方法。
|       规定必须围绕用户渗透、品效、供应链三条主线，
|       并说明 overview、indicators、tree、area、category、trend
|       各自承担什么证据角色。
|
+-- templates/business-overview-report.md
    |
    +-- 作用:
        定义最终报告形态。
        固定 1 到 9 章结构、指标归属、表格结构和诊断表达规则。
```

### 3. 提示词进入 Hook 的细节

Claude Code 读取 `.claude/settings.json` 后，会注册下面的钩子命令：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/qdm-harness-context.py\""
          }
        ]
      }
    ]
  }
}
```

当用户提交 `昨天的经营情况` 时，数据进入脚本的路径如下：

```text
+-----------------------------+
| Claude Code                 |
| 发送 JSON 到 hook stdin     |
|                             |
| {"prompt":"昨天的经营情况"} |
+--------------+--------------+
               |
               v
+-----------------------------+
| qdm-harness-context.py      |
| 函数: main()                |
|                             |
| raw = sys.stdin.read()      |
+--------------+--------------+
               |
               v
+-----------------------------+
| 函数: parse_prompt(raw)     |
|                             |
| 从 JSON 中取出 prompt 字段  |
| 得到: "昨天的经营情况"      |
+-----------------------------+
```

如果输入不是合法 JSON，或者没有 `prompt` 字段，`parse_prompt` 会返回空字符串，脚本直接退出，不注入任何上下文。

### 4. 意图识别细节

`qdm-harness-context.py` 使用 `BUSINESS_OVERVIEW_RE` 判断提示词是否命中经营概览意图。

```text
+--------------------------+
| prompt                   |
| "昨天的经营情况"         |
+------------+-------------+
             |
             v
+--------------------------+
| BUSINESS_OVERVIEW_RE     |
|                          |
| 经营/业务表现/整体表现   |
| 营业/销售                |
|        +                 |
| 情况/分析/表现/报告      |
| 复盘/概览/怎么样         |
+------------+-------------+
             |
             v
+--------------------------+
| 命中 business_overview   |
+--------------------------+
```

这个例子里，提示词同时包含 `经营` 和 `情况`，所以命中。命中后，后续固定意图字段来自 `intents/business-overview.md`：

```yaml
query_type: business_overview
report: business
needs_clarification: false
depth: deep_report
```

如果没有命中，例如用户只是问“查一下品效指标定义”，脚本会直接退出，不会注入经营分析报告上下文。

### 5. 时间上下文细节

命中意图后，脚本调用 `build_time_context(prompt, current_date)`。当前日期优先来自环境变量 `QDM_HARNESS_CURRENT_DATE`，没有该变量时使用系统日期。

以当前日期 `2026-05-21` 为例：

```text
+-------------------------------+
| 输入                           |
| prompt = "昨天的经营情况"      |
| current_date = "2026-05-21"    |
+---------------+---------------+
                |
                v
+-------------------------------+
| build_time_context()          |
|                               |
| 提供 current_date/timezone    |
| 不预设最终 CLI 时间过滤       |
+---------------+---------------+
                |
                v
+-------------------------------+
| 输出 time_context             |
|                               |
| current_date: 2026-05-21      |
| timezone: Asia/Shanghai       |
| time_policy: 参考             |
| spec/qdm-time-policy.md       |
+-------------------------------+
```

对应 JSON 为：

```json
{
  "current_date": "2026-05-21",
  "timezone": "Asia/Shanghai",
  "time_policy": "Use spec/qdm-time-policy.md to infer --date, --week, or --month. Do not use date ranges.",
  "prompt": "昨天的经营情况"
}
```

时间口径规则由 `spec/qdm-time-policy.md` 统一约束，hook 只注入当前日期和规则，不直接替模型计算最终 CLI 参数：

```text
明确日期  -> --date YYYY-MM-DD
今天/今日 -> --date 当前日期
昨天/昨日 -> --date 当前日期前一天
本周/这周/最近一周 -> --week 当前 QDM 业务周 value
上周      -> --week 上一 QDM 业务周 value
本月      -> --month YYYY-MM
上月      -> --month 上月 YYYY-MM
未给时间  -> 默认昨天
```

### 6. 附加上下文组装细节

时间上下文生成后，脚本调用 `build_context(prompt, project_dir, harness_dir, time_context)`。这个函数会把“硬编码强制约束”、统一 CMR CLI 说明和仓库里的规格文件拼成一份完整上下文。

```text
+---------------------------------------------------+
| build_context()                                   |
+-------------------------+-------------------------+
                          |
                          v
+---------------------------------------------------+
| 先写入脚本内置强制约束                            |
|                                                   |
| - query_type=business_overview                    |
| - report=business                                 |
| - needs_clarification=false                       |
| - 必须走 qdm-cmr-cli                              |
| - 推荐查询 overview/indicators/tree/area/...      |
| - CMR CLI 参数规则以 spec/cmr-cli-readme.md 为准 |
| - 章节顺序固定为 1 到 9                           |
| - 数值必须来自 CLI                                |
+-------------------------+-------------------------+
                          |
                          v
+---------------------------------------------------+
| append_file(): 追加取数阶段必要文件               |
|                                                   |
| 1. spec/cmr-cli-readme.md                         |
| 2. spec/qdm-time-policy.md                        |
| 3. intents/business-overview.md                   |
| 4. routing/business-overview.md                   |
| 5. spec/business-report.md                        |
| 6. playbooks/business-overview-analysis.md        |
|                                                   |
| template 不在此阶段注入。                         |
| 它由 PostToolUse 在 before-report-signal          |
| 成功后按 report 二阶段注入。                      |
+-------------------------+-------------------------+
                          |
                          v
+---------------------------------------------------+
| 返回 additionalContext                            |
+---------------------------------------------------+
```

最终脚本返回给 Claude Code 的结构是：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

也就是说，这个脚本的输出不是报告正文，而是一大段“本轮回答必须遵守的上下文”。

### 7. Claude 收到上下文后的 CLI 路由

Claude 收到 `additionalContext` 后，应按已命中的单 report 路由文件选择 CLI。以经营分析为例，hook 只注入 `routing/business-overview.md`。

```text
+------------------------------+
| additionalContext            |
| query_type=business_overview |
+---------------+--------------+
                |
                v
+------------------------------+
| routing/business-overview.md |
|                              |
| 允许: qdm-cmr-cli            |
| 禁止: qdm-indicators-cli     |
+---------------+--------------+
                |
                v
+------------------------------+
| config/qdm-cli-paths.env     |
|                              |
| QDM_CMR_CLI=/Users/...       |
+---------------+--------------+
                |
                v
+------------------------------+
| 使用 $QDM_CMR_CLI 查询 CMR   |
+------------------------------+
```

路径配置在 `config/qdm-cli-paths.env`：

```bash
QDM_CMR_CLI=/Users/pengmd/c/qdm/cmr-cli/dist/qdm-cmr-cli
QDM_INDICATORS_CLI=/Users/pengmd/c/qdm/indicators-cli/dist/qdm-indicators-cli
QDM_CAS_CLI=/Users/pengmd/c/qdm/cas-cli/dist/cas-cli
```

对 `昨天的经营情况`，必须使用 `QDM_CMR_CLI`，并带上时间过滤条件 `--date 2026-05-20`。

### 8. CMR 查询取证流程

`playbooks/business-overview-analysis.md` 规定经营概览不是一句话摘要，而是多模块取证后的深度报告。

```text
+------------------------------------------------+
| qdm-cmr-cli report business                    |
| 时间过滤: --date 2026-05-20                    |
+----------------------+-------------------------+
                       |
        +--------------+--------------+--------------+
        |              |              |              |
        v              v              v              v
+---------------+ +-------------+ +-------------+ +-------------+
| overview      | | indicators  | | tree        | | trend       |
|               | |             | | --values    | |             |
| 确认整体表现  | | 核心指标值  | | 指标拆解树  | | 时间趋势    |
+---------------+ +-------------+ +-------------+ +-------------+
        |              |              |              |
        +--------------+--------------+--------------+
                       |
        +--------------+--------------+
        |                             |
        v                             v
+---------------+             +---------------+
| area          |             | category      |
|               |             |               |
| 区域差异      |             | 品类结构      |
+---------------+             +---------------+
```

推荐并行命令骨架：

```bash
source config/qdm-cli-paths.env

"$QDM_CMR_CLI" report business overview --date 2026-05-20 --ai &
"$QDM_CMR_CLI" report business indicators --date 2026-05-20 --ai &
"$QDM_CMR_CLI" report business tree --values --date 2026-05-20 &
"$QDM_CMR_CLI" report business area --date 2026-05-20 --ai &
"$QDM_CMR_CLI" report business category --date 2026-05-20 --ai &
"$QDM_CMR_CLI" report business trend --date 2026-05-20 --ai &
wait
```

这六个必要模块没有业务顺序依赖，可以并行执行；`wait` 确认整体成功后，下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py business-overview`。在 signal 前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。`table` 仍然只是可选补充，不进入六模块门禁。

各模块分工：

```text
overview   -> 报告对象、时间口径、整体表现
indicators -> 核心指标值、同比、环比、阈值、达成情况
tree       -> 一级指标到子指标的拆解路径
area       -> 区域维度的拖累或亮点
category   -> 品类维度的结构、品效和动销问题
trend      -> 短期波动、持续下滑或异常峰谷
table      -> 可选，只有需要更细颗粒度明细时才调用
```

### 9. 证据到分析主线的映射

`playbooks/business-overview-analysis.md` 和 `templates/business-overview-report.md` 共同规定：报告只能围绕三条主线组织。

```text
CLI 返回证据
     |
     v
+-------------------------------------------------------------+
| 证据归类                                                    |
+---------------------+-------------------+-------------------+
| 用户渗透            | 品效              | 供应链            |
+---------------------+-------------------+-------------------+
| 客数渗透率          | 品效              | 活跃供应商数      |
| 销售额              | 定价毛利率        | 集采入库占比      |
| 客数                | 售价价格指数      | 三率综合得分      |
| 客单价              | 预期毛利率        | 准确率            |
| 19点前转化链路      | 时段折扣率        | 准点率            |
| 全链路毛利率/额     | 促销折扣率        | 合格率            |
| 商品订购渗透        | 损耗率            |                   |
+---------------------+-------------------+-------------------+
```

关键规则：

- 销售额、客数、客单价固定归入用户渗透维度。
- 准确率、准点率、合格率固定归入供应链维度。
- signal 后注入的 template 约束最终报告结构；取数阶段按已注入 spec 判断指标归属。
- CLI 没有返回的数据直接省略，不列“缺失项”。
- 数值、同比、环比、排名、阈值、异常点都必须来自 CLI 输出。

### 10. 最终报告生成流程

最终输出由 signal 后二阶段注入的 template 约束。Claude 不能自由改变章节顺序；signal 前不读取、不使用 template。

```text
+------------------------------+
| CLI 证据                     |
+---------------+--------------+
                |
                v
+------------------------------+
| playbook 分析规则            |
| business-overview-analysis.md|
+---------------+--------------+
                |
                v
+------------------------------+
| report template              |
| business-overview-report.md  |
+---------------+--------------+
                |
                v
+------------------------------+
| 最终深度经营分析报告         |
|                              |
| 1. 报告概述                  |
| 2. 核心指标总览              |
| 3. 用户渗透维度深度拆解      |
| 4. 品效维度深度拆解          |
| 5. 供应链维度深度拆解        |
| 6. 关键问题与根因分析        |
| 7. 优化策略与行动建议        |
| 8. 风险提示与后续跟踪        |
| 9. 附录：指标定义说明        |
+------------------------------+
```

诊断表达固定为：

```text
现象 -> 影响 -> 推断
```

建议生成规则：

```text
已返回 CLI 证据
      |
      v
识别问题或风险
      |
      v
形成短期动作和长期动作
      |
      v
写入第七章“优化策略与行动建议”
```

推断只能基于已返回数据做有限判断。不确定时应使用“可能”“倾向于”，并说明证据边界。

### 11. 端到端链路压缩图

```text
用户:
  "昨天的经营情况"
    |
    v
.claude/settings.json:
  UserPromptSubmit -> qdm-harness-context.py
    |
    v
qdm-harness-context.py:
  parse_prompt()
    |
    v
qdm-harness-context.py:
  BUSINESS_OVERVIEW_RE 命中 business_overview
    |
    v
qdm-harness-context.py:
  build_time_context()
  注入 current_date/timezone/time policy
    |
    v
qdm-harness-context.py:
  build_context()
  追加 CMR readme/time policy/intents/routing/spec/playbooks
    |
    v
Claude Code:
  收到 hookSpecificOutput.additionalContext
    |
    v
config/qdm-cli-paths.env:
  读取 QDM_CMR_CLI
    |
    v
qdm-cmr-cli:
  report business overview/indicators/area/category/trend --ai
  report business tree --values
    |
    v
playbooks/business-overview-analysis.md:
  按用户渗透、品效、供应链三条主线诊断
    |
    v
templates/business-overview-report.md:
  按固定 1-9 章输出深度经营分析报告
```

这套运行约束的核心作用，是把一个泛化的自然语言问题，稳定地约束成一次可追溯、有固定结构、有 CLI 数据支撑的经营分析报告生成流程。
