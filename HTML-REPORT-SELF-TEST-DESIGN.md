# html-report 自动化自测方案

更新时间：2026-07-29（Asia/Shanghai）

状态：**已实施并完成本轮全流程验收**

## 1. 背景与目标

当前 `html-report` Skill 采用单步调试 Gate。每完成一个阶段，都需要人工检查并输入精确的“继续”，才能进入下一阶段；A_CONFIG 还需要打开 HTML 页面并点击“确认生成报告”。

这种方式适合定位问题，但每次修复后都依赖人工重复操作，成为调试效率的瓶颈。

本方案的目标是增加一个自动测试驱动器，让脚本充当“机器人测试员”：

1. 创建全新的 Pi Session。
2. 发送固定的 Skill 测试问题。
3. 保留现有单步 Gate，不切换成自动模式。
4. 每个阶段结束后运行确定性验收。
5. 只有阶段验收通过，才向同一个 Pi Session 输入“继续”。
6. 任一阶段出现错误、超时或明显性能异常时，立即停止，不批准下一 Gate。
7. 自动保存 Session ID、阶段时间线、错误证据和自测报告。

最终使用者只需执行一条命令，不再手工点击 HTML，也不再手工多次输入“继续”。

## 2. 固定测试问题

测试使用以下固定输入：

```text
/skill: html-report 生成客数(客流)和客单的平衡在哪个点最好? 用门店毛利额做评估, 以门店:101001为分析样本
```

### 2.1 Skill 命令前缀兼容

Pi 0.81.1 的原生 Skill 语法是：

```text
/skill:html-report <问题>
```

也就是冒号后没有空格。带空格的当前写法能被 qdm 扩展识别，但不会被 Pi 原生展开为完整的 `SKILL.md`，可能导致模型首轮额外读取 Skill 文件，并污染阶段耗时。

控制器保留上面的原始测试 Prompt 作为固定 fixture，但在送入 Pi 前只规范化命令前缀：

```text
/skill: html-report  →  /skill:html-report
```

业务问题文本不得变化。自测报告同时记录 `originalPrompt` 和 `effectivePrompt`，保证行为可追踪。

## 3. 用户最终执行的命令

### 3.1 完整测试

```bash
cd /Users/pengmd/c/qdm/harenss-data-github-ppt-master

node .agents/pi/skills/html-report/scripts/html-report-self-test.mjs --full
```

该命令从 A_CONFIG 一直执行到 B5_DESIGN。

### 3.2 只测试到指定阶段

调试 Writer：

```bash
node .agents/pi/skills/html-report/scripts/html-report-self-test.mjs \
  --until B2_WRITER
```

调试 Editor / Researcher：

```bash
node .agents/pi/skills/html-report/scripts/html-report-self-test.mjs \
  --until B3_RESEARCH
```

调试 Reviewer：

```bash
node .agents/pi/skills/html-report/scripts/html-report-self-test.mjs \
  --until B4_REVIEW
```

### 3.3 可选的 HTML 页面无头测试

默认使用快速、稳定的 HTTP 静默确认。只有修改 HTML 页面本身时，才运行真实无头浏览器模式：

```bash
node .agents/pi/skills/html-report/scripts/html-report-self-test.mjs \
  --until A_CONFIG \
  --confirm-mode browser
```

无论使用哪一种确认模式，都不能弹出可见浏览器窗口。

## 4. 总体流程

```text
html-report-self-test.mjs
  │
  ├─ 生成全新 Session ID
  ├─ 启动一个长生命周期的 Pi RPC 进程
  ├─ 发送固定 Skill Prompt
  │
  ▼
A_CONFIG 执行完成
  │
  ├─ 检查 Gate 状态
  ├─ 检查 recommendations.json
  ├─ 静默完成确认和真实 CLI 冒烟
  └─ 检查 result.json + layout phase=a
  │
  ├─ PASS ──► 向同一 Session 输入“继续”
  └─ FAIL ──► 不输入“继续”
                ├─ 保存 Session ID
                ├─ 收集日志和时间线
                ├─ 生成诊断报告
                └─ 关闭 Pi
  │
  ▼
B0_PREFLIGHT
  │
  ├─ PASS ──► “继续”
  └─ FAIL ──► 停止
  │
  ▼
B2_WRITER
  │
  ├─ PASS ──► “继续”
  └─ FAIL ──► 停止
  │
  ▼
B25_EDITOR ──内部自动衔接──► B3_RESEARCH
  │                              │
  └──────────── 合并验收 ◄───────┘
                 │
                 ├─ PASS ──► “继续”
                 └─ FAIL ──► 停止
  │
  ▼
B4_REVIEW
  │
  ├─ PASS ──► “继续”
  └─ FAIL ──► 停止
  │
  ▼
B5_DESIGN
  │
  └─ 完整验收并生成自测报告
```

## 5. 为什么使用长生命周期 Pi RPC

自动测试应启动一个持续到本次测试结束的 Pi 进程：

```bash
pi --mode rpc --approve --session-id "<UUID>"
```

不能在每个阶段重新执行一次 `pi --session <ID> ...`，原因包括：

1. 多个 Pi 进程可能同时写同一个 Session JSONL，而 Pi Session 文件没有并发写锁。
2. 每次重新启动都会重新加载扩展和运行时契约。
3. HTML Server、子代理和 Gate 上下文可能失去原进程生命周期。
4. 无法准确区分模型执行时间和进程重复启动时间。

非交互模式必须带 `--approve`，否则项目级 Skill 和扩展可能因项目未被信任而不加载。

### 5.1 RPC 控制规则

控制器通过严格 LF 分隔的 JSONL 与 Pi 通信。

启动后至少执行：

```json
{"id":"state-0","type":"get_state"}
{"id":"commands-0","type":"get_commands"}
```

必须检查：

- `sessionId` 与控制器生成的 ID 一致。
- `sessionFile` 是 Pi 返回的绝对路径；`get_state` 返回时文件可以尚未落盘。
- `get_commands` 中存在 `skill:html-report`。

首轮 A_CONFIG Prompt 达到 `agent_settled` 后，控制器会在有界时间内等待 `sessionFile` 可访问。这是第一次持久化校验：若文件仍不存在，则以 `PI_SESSION_FILE_MISSING` 停止，不进入 A_CONFIRM，也不会把缺失的 Session 记录当作空数据继续分析。

发送测试问题：

```json
{
  "id": "phase-a",
  "type": "prompt",
  "message": "/skill:html-report 生成客数(客流)和客单的平衡在哪个点最好? 用门店毛利额做评估, 以门店:101001为分析样本"
}
```

阶段是否结束必须以 `agent_settled` 为准，不能只看 `agent_end`。`agent_end` 后仍可能发生自动重试、上下文压缩重试或排队消息。

向下一阶段推进时，必须发送真实用户输入：

```json
{"id":"continue-b2","type":"prompt","message":"继续"}
```

不得直接运行 `stage-gate approve`，也不得直接修改 `pipeline-state.json`。

### 5.2 同 Session writer 审计

控制器在两个时点通过以下命令检查当前可见进程：

1. RPC 子进程启动且 `get_state` 返回后。
2. 每个外部阶段 A_CONFIG、B0_PREFLIGHT、B2_WRITER、B3_RESEARCH、B4_REVIEW、B5_DESIGN 达到 `agent_settled` 后。

```bash
ps -ww -axo pid=,command=
```

审计识别三种显式的同 Session 启动方式：

```text
--session-id <session-id>
--session <session-id>
--session <absolute-session-jsonl>
```

只要发现携带上述参数的进程，其 PID 就必须等于控制器持有的 RPC 子进程 PID；出现任何其他 PID，立即以 `PI_SESSION_WRITER_CONFLICT` 停止。

Pi 在 macOS 上可能主动把进程标题改写成裸 `pi`，使 `ps` 看不到原始 CLI 参数。因此“没有可见参数匹配”不能证明系统中不存在另一个隐藏参数的同 Session writer，也不能因为 Pi 的正常改标题行为直接误判为失败。该场景只在以下所有权证据同时成立时按兼容策略接受：Session ID 是控制器本轮新生成的 UUID、启动前对应 Session 不存在，并且 RPC 子进程 PID 来自本轮 `spawn()`。审计结果会记录使用的方法：

- `visible_session_argument`：可见的同 Session 参数只属于当前 RPC PID。
- `fresh_session_owned_rpc_pid`：Pi 隐藏了参数，使用新 Session 所有权和当前 RPC PID 作为兼容性证据；它不是操作系统层面对“绝无隐藏竞争 writer”的完全证明。

启动时和每个外部阶段后的复审都会拒绝任何新出现的可见冲突，但在裸 `pi` 场景下仍受上述可观测性边界约束。首轮 `agent_settled` 后的 Session JSONL 落盘校验用于证明预期文件已经持久化，同样不把隐藏参数 fallback 提升为系统级唯一性证明。

## 6. 保留单步 Gate

测试环境必须显式使用：

```text
HTML_REPORT_GATE_MODE=step
HTML_REPORT_A_CONFIG_MODE=fixed
HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN=0
```

禁止为节省时间设置：

```text
HTML_REPORT_GATE_MODE=auto
```

自动测试的价值正是每个 Gate 单独验收和计时。如果改成 auto，一旦后面出错，将再次难以定位到底是哪个阶段开始异常。

## 7. A_CONFIG 静默确认

### 7.1 默认 HTTP 模式

已实现的 `headless-confirm.mjs` 执行以下流程：

```text
recommendations.json
  │
  ├─ 校验固定推荐结构
  ├─ 为每张卡构造与网页一致的 requestBody
  ├─ 后台启动 server.mjs，但不传 --open
  ├─ POST /harness/confirm
  ├─ 服务端逐卡执行真实 Indicators CLI single-page 冒烟
  ├─ 服务端写入 result.json
  ├─ 核对 result.json 契约
  └─ POST /harness/shutdown 关闭服务
```

必须复用现有 `/harness/confirm` 服务端路径，不能直接伪造 `result.json`。

静默确认也不能滥用：

```json
{"already_validated": true}
```

只有确实执行并保存了逐卡验证结果时才能使用该字段。默认设计是让 `/harness/confirm` 自己执行一次真实校验，避免“声称已经校验但实际没有执行”。

确认完成后至少核对：

- `status === "confirmed"`
- `session_id` 等于本次 Pi Session ID
- `result_path` 等于当前 `$SESSION/result.json`
- 卡片数量与 `recommendations.json` 一致
- 每张卡都存在合法 `requestBody`
- `validation[]` 中每张卡均为成功
- `check-session-layout --phase a` 通过

### 7.2 可选 browser 模式

`--confirm-mode browser` 用无头浏览器访问 Server URL，等待页面加载推荐，点击“确认生成报告”，再检查 `result.json`。

该模式用于验证：

- 页面能正确载入推荐值。
- 推荐卡能转换成正确的 `requestBody`。
- 点击按钮能够调用确认接口。
- 页面错误提示和等待状态正常。

日常调试 B2/B3 不运行 browser 模式，以减少浏览器启动开销和 UI 波动。

## 8. 阶段验收矩阵

| 阶段边界 | 预期 Gate 状态 | 确定性检查 | 通过后的动作 |
| --- | --- | --- | --- |
| A_CONFIG | `awaiting_approval` | 推荐合法、静默确认成功、`result.json` 合法、`phase=a` | 输入“继续” |
| B0_PREFLIGHT | `awaiting_approval` | 四个 `report-*` Agent 注册完整、Session 与输入合法 | 输入“继续” |
| B2_WRITER | `awaiting_approval` | 每卡一次 Writer、结构化返回合法、entry/meta 完整、`phase=writer` | 输入“继续” |
| B25_EDITOR + B3_RESEARCH | B25 `completed` 且 B3 `awaiting_approval` | tasks/main/evidence/section/summary 合法、`phase=b2` 和 `phase=explore` | 输入“继续” |
| B4_REVIEW | `awaiting_approval` | Reviewer 一次、scan/verdict 签章一致、`phase=quality` | 输入“继续” |
| B5_DESIGN | Pipeline `completed` | HTML、内容 Hash、双视口截图、`phase=html` | 完成 |

### 8.1 A_CONFIG

检查：

- 使用固定推荐模式，未执行 Spec recall 或指标推荐搜索。
- 模型没有额外修改推荐 JSON。
- 没有因为 Skill 命令未展开而重复读取整个 `SKILL.md`。
- A_CONFIG 已完成并停在批准边界。
- HTML 静默确认结果满足第 7 节契约。

### 8.2 B0_PREFLIGHT

检查：

- Pi 能列出 `report-writer`、`report-researcher`、`report-reviewer`、`report-designer`。
- `result.json` 属于当前 Session。
- 运行时契约指纹匹配当前进程。
- 没有提前执行 Writer 或报告编辑。

### 8.3 B2_WRITER

检查：

- 每个确认卡片只派发一次 Writer。
- 不存在并行 Writer 或失败后的重复派发。
- Writer 只执行一次受权的取数入口。
- 每个成功卡片都有 `entry.json` 和最小 `entry.meta.json`。
- `rowCount`、`rowsSha256` 和数据路径正确。
- Writer 返回合法的结构化结果，而不是散文或临时文件路径。
- `check-session-layout --phase writer` 通过。

### 8.4 B25_EDITOR + B3_RESEARCH

B2.5 到 B3 是内部衔接，不发送额外“继续”。

B25 Editor 完成业务判断并写出 `tasks.json` / `main.md` 后，只调用一次 `finalize-editor-stage.mjs` 合并固定收尾动作：处理 pending `reuse_entry` evidence、执行 assemble、检查 `phase=b2` layout。该脚本不完成 Gate；随后仍必须独立调用一次 `stage-gate finish B25_EDITOR`，再由 Pipeline 进入 B3_RESEARCH。

检查：

- B25 Editor 已写出合法的 `main.md` 和 `tasks.json`。
- B25 `main.md` 没有手工复制明细表。
- `reuse_entry` 任务没有重新召回 Spec 或重新执行相同查询。
- `new_query` 只有在缺指标、维度、范围、过滤或对照时才能执行。
- Researcher 只读取紧凑 evidence，不读取完整 Writer `entry.json`。
- 每个完成任务只有一次 section、一次 summary 和一次结构化返回。
- section 不包含 Markdown 明细表。
- 数字、JSON Pointer 和 evidence 引用精确合法。
- `check-session-layout --phase b2` 与 `--phase explore` 均通过。

### 8.5 B4_REVIEW

检查：

- Reviewer 每个 Gate attempt 只执行一次。
- `quality-scan`、草稿、签章 verdict 顺序正确。
- R1–R7 分数范围和总分正确。
- `verdict.json` 的 producer 和 scan fingerprint 匹配。
- 失败审核不能被父代理手工改成通过。
- `check-session-layout --phase quality` 通过。

### 8.6 B5_DESIGN

检查：

- Designer 没有修改已验收的语义正文。
- `report.html` 内容 Hash 与编译内容一致。
- desktop 和 mobile 截图均已生成。
- visual check 与 design result 已签章。
- `check-session-layout --phase html` 通过。
- Pipeline 最终状态为 `completed`。

## 9. 异常即停策略

以下任一情况出现时，当前测试立即停止，不输入“继续”：

1. Gate 状态为 `failed`。
2. `agent_settled` 后 Gate 仍为 `running` 或意外变成 `paused`。
3. RPC 出现 `extension_error`。
4. Assistant 的 `stopReason` 为 `error` 或 `aborted`。
5. 子代理超时、非零退出、缺少结构化返回或产物验收失败。
6. 子代理 transcript 出现失败工具调用（`SUBAGENT_TOOL_FAILED`）、失败后的恢复重试（`SUBAGENT_FAILURE_RETRY`），或子代理 Assistant 的 `stopReason` 为 `error` / `aborted`。
7. Pi Session JSONL 缺失、不可读或格式非法（`PI_SESSION_JSONL_UNREADABLE`），或者已绑定的子代理 transcript JSONL 缺失、不可读或格式非法（`SUBAGENT_TRANSCRIPT_UNREADABLE`）；这类问题归为 `TEST_HARNESS`，不得静默按空记录处理。
8. 同一阶段出现未经授权的重复 Writer、Researcher 或 Reviewer 派发。
9. `check-session-layout` 失败。
10. 阶段超过性能软阈值。
11. 阶段超过硬超时。
12. 测试前后 Git 工作区源码指纹发生变化。

自动测试不能自行发送“重试当前阶段”。失败 Session 必须被保留用于诊断；修复代码后，应重启 Pi 并创建全新 Session 重新验证。

## 10. 安全终止 Pi

如果异常发生时 Pi 仍在执行：

1. 发送 RPC `abort`。
2. 如果处于 Provider 自动重试等待，再发送 `abort_retry`。
3. 等待 `agent_settled`，让扩展有机会将运行中的 Gate 持久化为暂停状态。
4. 关闭 RPC stdin，让 Pi 正常 dispose Session 和子进程。
5. 超时未退出时发送 `SIGTERM`。
6. 只有 `SIGTERM` 仍无法退出时才使用 `SIGKILL`。

不能在原 RPC 进程仍活着时，启动第二个 Pi 去恢复同一个 Session。

## 11. 性能验收

### 11.1 需要记录的时间

每阶段至少记录：

- Gate `executionDurationMs`
- 阶段总墙钟时间
- 父代理模型时间
- Writer / Researcher / Reviewer / Designer 子代理时间
- Indicators CLI 时间
- layout / assemble 等确定性脚本时间
- 父代理收尾时间
- 失败和重试次数

父代理相关时间按以下方式估算：

```text
父模型区间
  = Gate executionDuration
  - 子代理总耗时

父代理收尾估算
  = 父模型区间
  - 父阶段直接执行的 Indicators CLI / 固定脚本
```

子代理 transcript 中记录的 Indicators CLI 和固定脚本耗时是“子代理总耗时”的内部子集，只用于解释子代理慢在哪里，不能再从父模型区间中重复扣减。

### 11.2 两级阈值

每阶段设置：

- **软阈值**：阶段虽然完成，但视为性能回归，不批准下一 Gate。
- **硬阈值**：阶段仍未完成时立即 abort。

当前配置值如下，后续用多次正常运行的中位数和 P95 调整：

| 阶段 | 初始软阈值 | 初始硬阈值 |
| --- | ---: | ---: |
| A_CONFIG | 30 秒 | 60 秒 |
| A_CONFIRM（外部确认，不计 Gate） | 90 秒 | 180 秒 |
| B0_PREFLIGHT | 30 秒 | 60 秒 |
| B2_WRITER | 60 秒 | 120 秒 |
| B25_EDITOR | 60 秒 | 120 秒 |
| B3_RESEARCH | 75 秒 | 150 秒 |
| B4_REVIEW | 90 秒 | 180 秒 |
| B5_DESIGN | 180 秒 | 360 秒 |

阈值放在独立配置文件中，不能散落在控制器代码里。

## 12. 错误分类

自测报告应区分四类问题：

| 分类 | 示例 | 处理方向 |
| --- | --- | --- |
| `PRODUCT_CONTRACT` | 非法 structured output、重复派发、错误产物 | 修改 Skill、Guard、父级契约或脚本 |
| `PERFORMANCE_REGRESSION` | 阶段超过软阈值、父代理空转 | 分析时间线并优化流程 |
| `INFRASTRUCTURE` | Token、网络、Provider、CLI 后端超时 | 先处理环境，不误改业务流程 |
| `TEST_HARNESS` | RPC 控制器、静默确认器、报告生成器自身失败 | 修复自动测试基础设施 |

报告必须突出“第一个失败”，避免只展示后续连锁错误。

## 13. 自测产物

每次运行写到：

```text
.harness/test-runs/html-report/<session-id>/
  run.json                    # 输入、环境、模型、源码指纹
  rpc.jsonl                   # RPC 事件流，敏感字段脱敏
  stderr.log                  # Pi 独立 stderr
  stage-observations.json     # 各阶段墙钟、Gate、预算、异常观测
  checkpoints/
    A_CONFIG.json
    A_CONFIRM.json
    B0_PREFLIGHT.json
    B2_WRITER.json
    B25_EDITOR.json
    B3_RESEARCH.json
    B4_REVIEW.json
    B5_DESIGN.json
  self-test-report.json       # 机器可读结果
  self-test-report.md         # 人类可读述职报告
```

原始 html-report 运行产物继续位于：

```text
.harness/state/html-report/<session-id>/
```

Pi 原始 Session JSONL 继续由 Pi 写入其正常 Session 目录。分析器会读取并解析它，但不会复制或修改它；报告记录其绝对路径、观测状态，以及记录数、消息数、工具调用数和 Assistant 失败数。子代理 transcript 同样保留在原位置，报告记录其阶段/Agent 绑定、读取状态和记录数。

## 14. 自测报告格式

当前 Markdown 报告包含：

```text
# html-report 自测报告

结论：PASS / FAIL / PERFORMANCE_REGRESSION
Session ID：...
停止阶段：...
开始/结束时间：...
Pi / Provider / Model / Thinking：...
Git HEAD / 工作区指纹：...
固定 Prompt（原始）：...
固定 Prompt（实际）：...

| 阶段 | 状态 | attempt | 执行耗时 / 墙钟 | 预算 | 子代理 | 工具 | 重试 | layout |
| ...  | ...  | ...     | ...             | ...  | ...    | ...  | ...  | ...    |

## 第一个异常
- 分类：...
- 原因：...
- 发生时间：...
- 对应工具/子代理：...
- 日志证据：...

## 子代理 transcript 异常
- B5_DESIGN / SUBAGENT_TOOL_FAILED / compose-report：...
- B5_DESIGN / SUBAGENT_FAILURE_RETRY / compose-report：...

## 阶段耗时拆分
- B5_DESIGN：父模型区间 ...；子代理 ...；Indicators CLI ...（其中子代理内 ...）；固定脚本 ...（其中子代理内 ...）；父代理收尾估算 ...

## JSONL 观测源
- Pi Session：loaded；记录 ...；消息 ...；工具调用 ...；Assistant 失败 ...；/absolute/path/session.jsonl
- 子代理 transcript：loaded；B5_DESIGN / report-designer；记录 ...；/absolute/path/transcript.jsonl

## 产物路径
- Session：...
- Pi Session JSONL：...
- 子代理 transcript：...
- 完整 RPC 日志：...
```

命令行结束时打印最简摘要和绝对路径：

```text
结果：FAIL
停止阶段：B3_RESEARCH
Session ID：019f....
原因：Report Researcher missing_structured_output
报告：/absolute/path/self-test-report.md
```

## 15. 已实现文件

```text
.agents/pi/skills/html-report/
  html-report-self-test.config.json
  scripts/
    html-report-self-test.mjs
    pi-rpc-client.mjs
    headless-confirm.mjs
    browser-confirm.mjs
    finalize-editor-stage.mjs
    analyze-html-report-run.mjs
  test/
    html-report-self-test-runner.test.mjs
    pi-rpc-client.test.mjs
    headless-confirm.test.mjs
    browser-confirm.test.mjs
    finalize-editor-stage.test.mjs
    analyze-html-report-run.test.mjs
```

### 15.1 `html-report-self-test.mjs`

职责：

- 生成全新 Session ID。
- 启动和管理长生命周期 Pi RPC。
- 发送固定 Prompt 与逐阶段“继续”。
- 等待 `agent_settled`。
- 调用阶段检查器。
- 在错误或超时后安全终止。
- 输出最终报告路径。

### 15.2 `pi-rpc-client.mjs`

职责：

- 启动一个长生命周期 `pi --mode rpc --approve --session-id <UUID>` 子进程。
- 使用严格 LF JSONL 发送请求并关联响应。
- 记录 RPC 事件、独立 stderr 和进程 PID。
- 等待 `agent_settled`，并支持 `abort`、`abort_retry` 与分级终止。

### 15.3 `headless-confirm.mjs`

职责：

- 读取 `recommendations.json`。
- 构造确认卡片和 `requestBody`。
- 启动无可见窗口的本地 Server。
- 调用 `/harness/confirm` 并执行真实 CLI 冒烟。
- 验证 `result.json`。
- 关闭 Server。

### 15.4 `browser-confirm.mjs`

职责：

- 使用无头浏览器打开本地推荐确认页，不弹出可见窗口。
- 等待推荐卡载入并点击“确认生成报告”。
- 核对 Indicators CLI 验证、`result.json` 和 `phase=a` layout。
- 将浏览器启动、交互、页面或确认失败映射为明确的测试异常。

### 15.5 `finalize-editor-stage.mjs`

职责：

- 在 B25 Editor 已完成业务判断并写出 `tasks.json` / `main.md` 后执行确定性收尾。
- 仅合并 pending `reuse_entry` evidence 准备、assemble 和 `phase=b2` layout 检查。
- 不代替 B25 Gate 完成动作；成功返回后仍由独立的 `stage-gate finish B25_EDITOR` 结束该阶段。

### 15.6 `analyze-html-report-run.mjs`

职责：

- 解析 Gate ledger、RPC JSONL、Pi Session JSONL 和子代理 transcript。
- 从父级 SubAgent 结果提取 transcript 绝对路径，并绑定到父阶段和 Agent。
- 建立阶段时间线。
- 统计工具、子代理、Indicators CLI、固定脚本、失败和重试次数。
- 识别子代理工具失败、失败恢复重试，以及 Pi/子代理 Assistant 的 `error` / `aborted`。
- 识别第一个异常。
- 生成 JSON 与 Markdown 报告。

### 15.7 测试与配置

- `html-report-self-test.config.json` 集中保存各阶段软阈值、硬阈值和 RPC 配置。
- `html-report-self-test-runner.test.mjs` 验证阶段推进、A_CONFIRM、首轮 Session 文件持久化和同 Session writer 审计。
- `pi-rpc-client.test.mjs` 验证 RPC 请求、响应、事件和退出行为。
- `headless-confirm.test.mjs` 与 `browser-confirm.test.mjs` 分别验证 HTTP 静默确认和真实无头页面确认。
- `finalize-editor-stage.test.mjs` 验证 B25 固定收尾顺序、running Gate 前置条件和 layout 失败行为。
- `analyze-html-report-run.test.mjs` 验证 Pi Session/子代理 transcript 读取、异常识别和不重复扣减的耗时拆分。

## 16. 测试分层

当前日常验证分三层：

### 第一层：确定性单元测试

```bash
node --test .agents/pi/skills/html-report/test/*.test.mjs
```

不调用真实模型，验证脚本、Guard、layout、RPC 状态机和报告生成器。

### 第二层：目标阶段端到端测试

根据本次修改范围，只跑到相关阶段：

```bash
# Writer 修改
node .agents/pi/skills/html-report/scripts/html-report-self-test.mjs --until B2_WRITER

# Editor / Researcher 修改
node .agents/pi/skills/html-report/scripts/html-report-self-test.mjs --until B3_RESEARCH
```

### 第三层：提交前完整测试

```bash
node .agents/pi/skills/html-report/scripts/html-report-self-test.mjs --full
```

只有完整测试通过，才认为整套 Skill 没有跨阶段回归。

## 17. 实施记录

| 能力 | 实现状态 | 实现位置与说明 |
| --- | --- | --- |
| 长生命周期控制器 | 已完成 | `html-report-self-test.mjs` 创建新 Session、发送固定 Prompt、按验收结果输入“继续”并安全终止 |
| Pi RPC 客户端 | 已完成 | `pi-rpc-client.mjs` 处理 LF JSONL、请求关联、`agent_settled`、stderr 和退出生命周期 |
| Session 所有权与持久化 | 已完成 | 启动时及每个外部阶段 `agent_settled` 后审计可见 writer；裸 `pi` 时明确采用有边界的新 Session + RPC PID fallback；首轮 A_CONFIG 后等待 Session JSONL 落盘，缺失时报 `PI_SESSION_FILE_MISSING` |
| A_CONFIG HTTP 静默确认 | 已完成 | `headless-confirm.mjs` 复用真实 `/harness/confirm`，不伪造 `result.json` |
| A_CONFIG 无头浏览器确认 | 已完成 | `browser-confirm.mjs` 验证页面加载、交互、CLI 结果和 layout，不打开可见窗口 |
| 阶段边界与检查点 | 已完成 | A_CONFIG、A_CONFIRM、B0、B2、B2.5、B3、B4、B5 均写独立 checkpoint；B2.5 到 B3 不多发一次“继续” |
| B25 固定收尾 | 已完成 | `finalize-editor-stage.mjs` 只合并 pending reuse evidence、assemble 和 b2 layout，之后仍独立执行 `stage-gate finish B25_EDITOR` |
| B25 软预算即时中止 | 已完成 | B3_RESEARCH 刚进入 running 时立即复核已完成 B25 的执行耗时；若超过 B25 soft 预算，立刻中止，不等待 B3 完成 |
| JSONL 与 transcript 审计 | 已完成 | `analyze-html-report-run.mjs` 读取 Pi Session JSONL，发现并绑定子代理 transcript，缺失/非法时报告 `TEST_HARNESS` |
| 失败重试与性能报告 | 已完成 | 报告包含首个异常、工具/子代理失败重试、阶段耗时拆分、JSONL 观测状态和绝对产物路径 |
| 确定性回归测试 | 已完成 | 对应测试覆盖控制器、RPC、HTTP/browser 确认、B25 固定收尾和分析器；本轮实际结果见第 20 节 |

## 18. 完成标准

当前验收必须满足：

- 用户只执行一条命令即可运行测试。
- 默认不出现可见浏览器窗口。
- 每个阶段仍保留独立 Gate 和独立计时。
- 脚本只能通过真实 Pi 输入推进 Gate。
- B25_EDITOR 到 B3_RESEARCH 不错误地多输入一次“继续”。
- 任一错误或性能异常都不会通过当前 Gate。
- 失败后不自动重试当前阶段。
- 每次测试使用全新 Session。
- 每次修改运行时代码后重新启动 Pi。
- 自动返回 Session ID 和 Markdown 报告绝对路径。
- 能明确回答“慢在哪个阶段、哪个子代理、哪个工具以及是否由失败重试造成”。
- 测试前后不得产生未授权的源码改动。
- 测试结束后不得残留 Pi、Server 或 SubAgent 进程。

## 19. 最终使用体验

用户运行：

```bash
node .agents/pi/skills/html-report/scripts/html-report-self-test.mjs --full
```

脚本内部自动完成：

```text
启动 Pi
  → 发送固定 Skill Prompt
  → 静默确认 HTML 推荐
  → 检查 A_CONFIG
  → 输入“继续”
  → 检查 B0
  → 输入“继续”
  → 检查 B2
  → 输入“继续”
  → 检查 B2.5 + B3
  → 输入“继续”
  → 检查 B4
  → 输入“继续”
  → 检查 B5
  → 输出 PASS 报告
```

如果 B3 出现异常：

```text
检查 B3 失败
  → 不输入“继续”
  → 保留当前 Session
  → 安全关闭 Pi
  → 输出 Session ID
  → 生成 B3 时间线和失败报告
```

之后可以由开发者或 Codex 直接根据报告完成“分析 → 修复 → 新 Session 重测”的闭环，不再依赖人工重复操作。

## 20. 2026-07-29 最终验收记录

完整命令：

```bash
node .agents/pi/skills/html-report/scripts/html-report-self-test.mjs --full
```

本轮完整测试使用新 Session 实际执行，结果如下：

- 最终结果：`PASS`
- Session ID：`a906a917-b04d-4e13-a7eb-09359e6a8b38`
- 开始时间：`2026-07-29T12:37:22.301Z`
- 结束时间：`2026-07-29T12:43:47.477Z`
- 总墙钟时间：`6 分 25.176 秒`
- 报告绝对路径：`/Users/pengmd/c/qdm/harenss-data-github-ppt-master/.harness/test-runs/html-report/a906a917-b04d-4e13-a7eb-09359e6a8b38/self-test-report.md`
- 确定性测试：`339/339 PASS`

browser 确认模式另行完成专项验收：

- 最终结果：`PASS`
- Session ID：`295f497e-bc3b-4a8b-b45c-9c5ba25958ba`
