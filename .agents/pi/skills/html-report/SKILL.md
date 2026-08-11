---
name: html-report
description: Recall Harness Specs, open HTML card builder for user confirm, then orchestrate report generation from result.json (no template inject).
---

# HTML Report

The original user question appears after the closing `</skill>` tag in Pi's expanded prompt. Use only that trailing text for recall/configure; never include this file's instructions in the question.

There are **two phases**. Phase A ends when HTML confirm writes `result.json`. Phase B starts when the user asks to **生成报告** (or equivalent) after confirm.

Full architecture (P0–P5) is locked in:

`docs/html-report-pipeline.md`

## 固定推荐调试模式

当前调试期，qdm-harness 扩展会在**模型开始前**直接写入固定的门店 `101001` 推荐配置并
打开既有 HTML builder。它跳过 Spec recall、指标检索和推荐生成，只用于调试
「推荐 JSON → HTML 确认 → result.json → Markdown 报告与质检」链路。

- 预设字段：`custNum`、`perCustAmt`、`profitLostRate`、`profitAmt`；按 `incDate`，门店
  `101001`，日期仍为当月 1 日至昨日。
- 该模式下 A_CONFIG 的固定推荐和 runtime agent list 都由扩展在模型开始前完成。
  runtime list 仍走真实 pi-subagents runtime discovery，并按 Session/Gate attempt 写入
  `$SESSION/debug/runtime-agent-list/` 审计文件；它不是静态文件替代检查。
- Agent 不得再次调用 `subagent({ action: "list" })`、`stage-gate status`，也不得重新
  读取 Spec、改写推荐或检查 Session 目录。看到 completed Gate 后立即原样返回并停止，
  等待 HTML 静默/人工确认及下一条“继续”。
- 仅 `html-report` 技能调用会关闭 Harness recall；同一 Pi 进程中的普通非技能问题仍保留
  原来的召回行为。
- **B5 当前也属于调试跳过范围**：固定推荐调试 Session 在 B4 通过后由扩展自动完成
  `B5_DESIGN`，不派发 `report-designer`，也不运行 compile/compose/capture、截图验收或
  `--phase html` layout。因此不会生成 `report/report.html`、截图或 HTML 设计签章；本轮
  调试的最终业务产物是已通过 B4 的 `report/report.md` 与 `quality/*`。该规则只作用于
  当前固定推荐调试 Session，不影响动态推荐模式。
- 要恢复本技能下面的正常动态推荐流程，显式以
  `HTML_REPORT_A_CONFIG_MODE=dynamic pi ...` 启动 Pi。动态模式会恢复完整 B5 Report
  Designer；`fixed` 或未设置该变量均使用固定预设并自动跳过 B5 设计。

## Pi runtime prerequisite — extension-owned (hard stop)

This skill currently supports the **Pi Agent runtime only**. Before the parent
model starts Phase A, qdm-harness emits an in-process pi-subagents slash bridge
request with exactly `{ action: "list" }`. The extension binds the response to
the current Session and Gate attempt and verifies `report-writer`,
`report-researcher`, `report-reviewer`, and `report-designer`.

The parent model must not repeat this call. A missing bridge, timeout, malformed
response, missing Agent, or invalid audit automatically fails `A_CONFIG`. When
the Gate is failed, show the user prompt below and stop; do not search settings,
try a substitute, or hand-run `stage-gate fail`.

`check-report-agents.mjs` checks repository files only; it never replaces this
runtime check. Never work around a failed check with `pi --print`, another Pi
process, builtin `worker` / `delegate`, or by impersonating a `report-*` agent.

**User prompt (must tell fully):**

> ## Cannot start html-report: Pi SubAgent is not available
>
> html-report requires the Pi `subagent` tool and these four runtime agents:
> **`report-writer`**, **`report-researcher`**, **`report-reviewer`**,
> **`report-designer`**.
>
> 1. Run `pi config` and enable the `npm:pi-subagents` extension (installed but
>    filtered/disabled is still unavailable).
> 2. Confirm the four files exist under the repo-root `.pi/agents/` directory.
> 3. Restart Pi from the repository root.
> 4. Then reply **「重试当前阶段」**; the extension will run the runtime list again
>    for the new Gate attempt.

## Mandatory stage Gate and timing

The qdm-harness extension initializes every new html-report Pi session in
`step` mode unless `HTML_REPORT_GATE_MODE=auto`. Persistent state lives at:

```text
$SESSION/debug/pipeline-state.json
```

There are six human Gates and one separately timed internal stage:

| Order | Timed stage | Human stop |
| --- | --- | --- |
| 1 | `A_CONFIG` | yes |
| 2 | `B0_PREFLIGHT` | yes |
| 3 | `B2_WRITER` | yes |
| 4 | `B25_EDITOR` | no; included in the B3 Gate |
| 5 | `B3_RESEARCH` | yes; reports Editor and Researcher times separately |
| 6 | `B4_REVIEW` | yes; every failed repair attempt is a new Gate |
| 7 | `B5_DESIGN` | final completion（固定推荐调试模式由扩展自动跳过；动态模式执行 Designer） |

For every stage, the mandatory order is `start → 工作 → layout → finish/fail → stop`:

```text
start (the extension starts it) → stage work → stage layout check →
stage-gate finish/fail as one standalone tool call → stop
```

- `stage-gate finish` or `fail` must be the **last call of that stage**, must be
  the only command in its Bash tool call, and must never be emitted in parallel
  with work for the next stage.
- Copy every `stage-gate` command exactly as shown. Never append `2>&1`, a pipe,
  redirect, `&&`, or another command; Pi already captures stderr. A decorated
  Gate command is rejected and aborts the current automated test stage.
- In `step` mode, after a human Gate return the exact timing text from the tool
  and stop. Only the user's exact reply **“继续”** starts the next stage.
- A failed Gate only accepts **“重试当前阶段”**. Ordinary “继续” cannot skip it.
- `B25_EDITOR` is the exception to the human stop: its standalone `finish`
  automatically starts `B3_RESEARCH`; continue B3 after that tool result.
- In `auto` mode the same timing calls remain, but successful stages advance
  without approval. No approval file is required by layout checks.
- **“关闭单步调试并继续”** switches the current session to auto mode.
- Never call `approve`, `retry`, or `resume` yourself. The extension owns those
  transitions from user input.

Read-only status command:

```bash
node .agents/pi/skills/html-report/scripts/stage-gate.mjs \
  status --session-dir "$SESSION" --format text
```

---

## Phase A — 配置确认（打开 HTML）

**Goal:** Recommend Indicators **card configuration** and open the local HTML builder.
**Do not** collect business numbers for the final report in this phase. **Do not** run full multi-page report fetch here. **Do not** inject-template.

### A workflow

The extension-owned Pi runtime prerequisite above has passed and the extension
has already started `A_CONFIG`. Resolve its session directory:

```bash
SESSION="$(pwd)/.harness/state/html-report/${PI_SESSION_ID:?PI_SESSION_ID must be set}"
```

1. From the repository root run:

   ```bash
   node .agents/pi/skills/html-report/scripts/prepare.mjs \
     --question "<original question>" \
     --session-id "${PI_SESSION_ID:?PI_SESSION_ID must be set by the Pi extension}"
   ```

   Uses `data-harness-cli wikis recall-debug --doc-set specs` (Spec-only).
   Default CLI recall without this skill still returns playbooks for single/multi — do not change that path yourself.

2. **If `specs` is non-empty:** read **only** those Spec paths.
   **If `emptyRecall`:** explore via `wikis/metrics|reports/**/index.md` then Spec only. Do not use playbooks for 取数.

3. If `supported` is false, explain non-Indicators/CMR/SQL cannot convert, then
   make this the final standalone tool call and stop:

   ```bash
   node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail \
     --session-dir "$SESSION" --stage A_CONFIG \
     --reason "recalled report is not supported by Indicators" --format text
   ```

4. Write version `1` JSON at `recommendationsPath` (cards with indicators/dims/dates/filters; `chartType: table`).
   Prefer codes from Specs; free-mode may add missing metrics with `warnings`.
   **Every card must include non-empty `analysisFocus`**（章节写作 brief：分析什么、看什么关系、评估什么指标）。缺少会被 `validate-config` 拒绝。

   **Minimal valid card shape** (field names must match — first validate failures are usually wrong keys):

   `cards[].id` must already be filesystem-safe and unchanged by sanitization:
   only `A-Z a-z 0-9 . _ -`, never `/`, spaces, `.` or `..` as the whole id.

   ```json
   {
     "version": 1,
     "sessionId": "<session-id>",
     "mode": "free",
     "userQuestion": "<user question>",
     "warnings": [],
     "cards": [
       {
         "id": "sample-card-001",
         "title": "…",
         "analysisFocus": "…",
         "chartType": "table",
         "indicatorFieldList": ["custNum", "perCustAmt", "profitAmt"],
         "aggDimUniqueCodeList": ["incDate"],
         "startDate": "2026-07-01",
         "endDate": "2026-07-21",
         "storeCollectType": 2,
         "filters": [
           { "type": "DIMENSION", "dimUniqueCode": "storeId", "values": ["101001"] }
         ]
       }
     ]
   }
   ```

   Full example: `.agents/pi/skills/html-report/scripts/fixtures/recommendations.example.json`

   **Date range（每卡强制，不超过一个月）：**

   - Inclusive span **≤ 31 days**: for each card, `(endDate - startDate) + 1 ≤ 31`. Longer windows are **rejected** by `validate-config`.
   - If the user does **not** specify a range: default to **the 1st of the current calendar month through yesterday**.
     Example: today is 2026-07-20 → `startDate=2026-07-01`, `endDate=2026-07-19`.
     If today is the **1st** of the month (no “yesterday” in the current month): use **previous month 1st through previous month last day** (full previous calendar month).
   - If the user asks for a longer period (e.g. last quarter / half year): still emit **only ≤ 31 days** (usually the most recent month), and add a top-level `warnings` note that the window was truncated; deeper/longer history belongs to Phase B Report Researcher — **never** a single 60–90 day card.
   - Prefer one time grain that fits a ≤31-day window (usually `incDate`). Do **not** open a second same-metric card only to show `incWeek` / `incMonth`.

   **Card diversity（避免重复卡）：**

   - Each card must earn its place: **indicator set**, **analysisFocus intent**, or **filters/scope** must differ in a material way.
   - **Forbidden:** same `indicatorFieldList` (as a set) + same effective filters, split only by time grain (`incDate` vs `incWeek` vs `incMonth`) — e.g. 日趋势 + 周趋势 + 同指标「平衡点」三张同构卡.
   - **Anti-pattern:** three cards all with `custNum + perCustAmt + profitAmt`, only day/week dims differ → merge into **one** card (daily + balance narrative in one `analysisFocus`), or at most a second card with a **real** difference (other metrics, structure dim, or different store filter).
   - **OK multi-card examples:** different metrics; trend vs true structural breakdown; same metrics but different store/region filters; report mode layers from Spec.
   - free mode: prefer **1–2** cards; use 3 only when each is clearly non-redundant. Prefer one card when one query answers the question.

   **Scope → filters（强制语义，防止只写在文案里）：**

   - If the user question names a **concrete scope** (门店 / 区域 / 品类 / 具体组织等), **every related card** must put that scope into **`cards[].filters`** as structured filters, e.g.
     `{ "type": "DIMENSION", "dimUniqueCode": "storeId", "values": ["101001"] }`
     (use the real dim code from Specs when known).
   - **Does not count as done:** only mentioning the store/region in `title` / `analysisFocus`, or only a top-level custom field like `storeId` **without** `cards[].filters`.
   - **Empty filters are OK only when:** the user explicitly wants full-store / company-wide / unrestricted scope, **or** the question has no scope constraint. Then add a short entry under top-level `warnings` explaining why filters are empty.
   - If a card uses row dim `storeId` (or similar) **without** filters, that is a full-cross-store query — prefer adding filters when the user named a store/sample.

5. Validate (metadata only — validator may use preview, not full report fetch):

   ```bash
   node .agents/pi/skills/html-report/scripts/validate-config.mjs <recommendationsPath>
   ```

   Notes:
   - Date span **> 31 days** → **error** (fix and re-validate).
   - If **all** cards lack effective filters, validate prints a **warning** on stderr but still exits 0 (full-scope queries are allowed). Fix filters when the user named a scope; do not ignore the warning blindly.

6. Start local server (**`--detach`**, auto-detects Pi process; do **not** pass `--watch-pid` / `$PPID`):

   ```bash
   node .agents/pi/skills/html-report/scripts/server.mjs \
     --config <recommendationsPath> \
     --session-id "${PI_SESSION_ID:?PI_SESSION_ID must be set by the Pi extension}" \
     --detach \
     --open
   ```

7. Verify page-state; tell the user to review/adjust in HTML and click **确认生成报告**.
   Confirm runs per-card **smoke** CLI (`--single-page`) then writes:

   `.harness/state/html-report/<session-id>/result.json`

   HTML will **soft-confirm** if any card still has no effective filters (full store/region/category risk). User may cancel to add filters or proceed intentionally.

8. After the URL is open and the page-state/config validation is complete,
   make this the final, standalone tool call for A_CONFIG:

   ```bash
   node .agents/pi/skills/html-report/scripts/stage-gate.mjs finish \
     --session-dir "$SESSION" --stage A_CONFIG --format text
   ```

   In `step` mode return the timing text and stop. The user may click the HTML
   button first and then reply **“继续”** or **“确认生成报告”**; the extension
   refuses A→B0 approval until `$SESSION/result.json` exists.

### Phase A bans

- Full multi-page report data collection for writing the narrative
- inject-template / reading templates as inject targets
- Inventing metric values in chat
- Putting user-named store/region/category **only** in prose (`title`/`analysisFocus`) without `cards[].filters`
- Card date range longer than **31 inclusive days**
- Multiple cards that only differ by time grain (`incDate` / `incWeek` / `incMonth`) with the same indicators and filters

### Phase A checklist

- [ ] `recommendations.json` written
- [ ] Each card date span ≤ 31 inclusive days (default: current month 1st → yesterday if unspecified)
- [ ] No redundant same-metric day/week/month-only card splits
- [ ] User-named scope written into each card `filters` (or `warnings` declare full-scope intentionally)
- [ ] `validate-config` passed (heed empty-filter warnings; fix date-span errors)
- [ ] URL opened / reported
- [ ] User can confirm → `result.json` in session dir

---

## Phase B — 生成报告（用户确认之后）

**Trigger:** user says **生成报告** / continue report / similar, with a confirmed `result.json`.

In step mode the extension only starts `B0_PREFLIGHT` after A_CONFIG is
approved and `result.json` exists. Never jump directly to Writer work.

**You are the Report Editor** (main session). Follow `docs/html-report-pipeline.md`. Roles:

| Display | Technical id | Asset |
| --- | --- | --- |
| **Report Editor** (you) | — | Own stages and consume typed handoffs; B2.5 artifacts are materialized deterministically |
| **Report Writer** | `report-writer` | Per-card SubAgent: fetch + concise analysis return |
| **Report Researcher** | `report-researcher` | Drill-down SubAgent per pending task |
| **Report Reviewer** | `report-reviewer` | Final R1–R7 scorecard SubAgent (B4) |
| **Report Designer** | `report-designer` | Isolated frontend design + visual QA SubAgent (B5) |
| Data scripts | — | fetch/assemble/compile/compose/check (no LLM person) |

### Report Editor duties (process owner, not a Pi agent)

Quality language: **`docs/html-report-quality-rubric.md`**.

| Principle | Rule |
| --- | --- |
| Own the question | Final `main.md` must answer the user question |
| Evidence first | Numbers only from `$SESSION/data/**` |
| Drill when weak | Gaps / shallow / low scores → **assignment + Report Researcher**, not re-spawn Writer for depth |
| Stage checklists | Short gates at B2/B2.5/B3.5; full R1–R7 only B4 |
| Spawn, do not impersonate | Must spawn Writer / Researcher / Reviewer / Designer; never write their artifacts yourself |
| No builtin worker | Never substitute Pi `worker` for any `report-*` agent |

**`tasks.json`:** compiled deterministically from the B2.5 Planner typed result,
then executed by **Report Researcher**. Writer `suggestedDeeper` is tips only;
Researcher `selfCheck` returns to Editor.

### Session root（强制路径，禁止写错）

Let `SESSION` = directory that contains `result.json`, always:

```text
.harness/state/html-report/<session-id>/
```

Resolve it from `result.json` path (dirname). **All Phase B reads/writes must use absolute paths under `SESSION`.**

| Allowed | Forbidden |
| --- | --- |
| `$SESSION/data/...` | repo-root `analysis/` |
| `$SESSION/analysis/...` | `./analysis/...` relative to cwd without SESSION prefix |
| `$SESSION/quality/...` | any path outside `$SESSION` for report artifacts |
| `$SESSION/report/...` | |

Before any write in Phase B:

```bash
SESSION="$(cd "$(dirname <result.json>)" && pwd)"
echo "SESSION=$SESSION"
# must print .../.harness/state/html-report/<session-id>
```

### B0 — four Report SubAgents gate (hard dependency)

This is a second extension-owned runtime check after the startup prerequisite;
the A_CONFIG result is never reused for B0.

Phase B requires these **Pi** agents (registry under `.pi/agents/`):

| Display | `name` |
| --- | --- |
| Report Writer | `report-writer` |
| Report Researcher | `report-researcher` |
| Report Reviewer | `report-reviewer` |
| Report Designer | `report-designer` |

**Before any fetch / analysis**, qdm-harness automatically emits one new
`{ action: "list" }` request through the real pi-subagents event bridge. It
validates all four names, the confirmed input/session and `phase=a` layout, then
finishes or fails B0 deterministically in the A_CONFIG approval input hook. In
`step` mode the extension consumes that input and writes the exact Gate text as
an `html-report-gate` custom message with `triggerTurn:false`; the parent model
does not start for this B0 acknowledgement.

Report Editor must not call `subagent list`, Bash, layout or `stage-gate` in B0.
If **any** bridge/input/session/agent/layout check fails, show the prompt below
and stop; do not retry within the same attempt or hand-write a fail command:

   **Do not**:
   - Use builtin `worker` / `delegate`
   - Write sections / explore / verdict / HTML yourself
   - Continue fetch / quality / render

**User prompt (must tell fully):**

> ## Cannot generate report: missing html-report SubAgent(s)
>
> Phase B needs: **`report-writer`**, **`report-researcher`**, **`report-reviewer`**, **`report-designer`**.
> Builtin `worker` is not allowed.
>
> ### Configure
>
> 1. Files under repo root: `.pi/agents/report-writer.md`, `report-researcher.md`, `report-reviewer.md`, `report-designer.md`
> 2. Pi **cwd = repo root**, pi-subagents installed
> 3. **Restart Pi** so the pi-subagents event bridge is loaded
> 4. Optional: `node .agents/pi/skills/html-report/scripts/check-report-agents.mjs`
> 5. 修复后回复「重试当前阶段」；扩展会在新 attempt 自动重新验收

Only when the input/session check passes and the automatic list has **all four**
does the extension finish B0. The consumed A_CONFIG approval cannot also approve
B0. Enter B1+B2 only after the user sends a **new** “继续” and the extension starts
`B2_WRITER`.

### B1 + B2 — 每卡 Report Writer（取数 + 简短分析返回，强制 SubAgent）

The extension owns this latency-critical stage:

1. Its initial `NEXT_TOOL_ONLY` is the exact mandatory stage-start status call;
   issue it alone. A successful result reveals one exact Writer call. Issue only
   that call—never merge calls, read `result.json`, or reconstruct arguments.
   If a provider emits an extra sibling beside the exact in-flight status, the
   extension blocks that sibling without executing it or invalidating the Gate;
   wait for the status result. After success only the exact revealed Writer is
   admitted until the handoff completes; parameter drift remains blocked.
2. Run the revealed `report-writer` calls one card at a time, including when
   there is only one card. Never bulk-fetch, impersonate Writer, or use parallel
   `tasks[]`. Each card/Gate attempt has one dispatch; do not retry or inspect
   child/session artifacts.
3. Accept only the extension-validated typed result. The child contract owns
   fetch/read/submit details and limits first-pass analysis to at most one
   literal `entry.json#/0` finding plus exactly one short qualitative action.
   Its `fetch-entry.mjs` path is all-pages and never uses `--single-page`.
   `qdm-harness` always replaces them with the exact per-card schema; a valid persisted
   entry/meta pair is reused automatically on a user-approved retry.
4. After a valid result, follow only the next exact call returned by the
   extension. It dispatches the next card or deterministically performs B2
   layout and finish/fail. Return the final Gate text and stop; never run parent
   layout/Gate commands or write/edit Writer data.

Shallow or unanswered analysis becomes a B2.5 Researcher task; never re-spawn
Writer for depth.

### B2.5 — Report Editor Planner（单次语义规划 + 确定性落盘）

全部 Report Writer 通过 B2 后，扩展启动 `B25_EDITOR`。本阶段只保留一次
数据清单桥接和一次语义规划；父代理不再手工编写 `tasks.json` 或
`main.md`。

#### B2.5.1 — 固定工具顺序

1. 严格执行 Gate 的 `IMMEDIATE B25 TOOL MESSAGE`：下一条 assistant
   消息只包含它给出的两个 sibling Bash，按原顺序列出
   `stage-gate status` 与 `--source-fields`。列表顺序只定义消息形状，
   不要求等待第一项完成；调用前不要复述、解释或重新规划。
2. 两个 Bash 都成功后，qdm-harness 直接通过真实 pi-subagents 事件桥派发
   一次 `context: "fresh"`、单步骤 `report-researcher` Planner；不再等待父模型
   生成固定的 Planner tool call。父模型不得手工派发、修改 marker/path/context/
   chain，或重复 Planner。
3. 当前 attempt 只允许这一次扩展拥有的 Planner 派发。失败后扩展自动 fail
   `B25_EDITOR`；不得重派、修补文件或改走普通 Researcher。

`--source-fields` 在本机校验每卡 Writer 的 `entry.json + entry.meta.json`，
只返回紧凑 source inventory，并把它绑定当前 `result.json` 的 SHA256 缓存。
inventory 包含状态、可用字段、`rowCount + rowsSha256` 以及字段无关的数据质量
信号；不返回明细行，也不改变 CLI 的三字段 metadata 契约。父代理不得再
`read/find/ls/grep` Writer 文件、临时子代理目录或 analysis 目录。

#### B2.5.2 — Planner 契约

Planner 复用运行时 Agent `report-researcher`，但本次内部契约角色是
`report-editor-planner`；不新增第五个 Agent，也不进入普通 B3 Researcher
的 task/retry 流程。父扩展会覆盖调用者提供的 schema、cwd、model、context 和
budget，并注入以下权威紧凑输入：

- 用户问题与报告标题；
- 每卡已确认的查询范围；
- B2 已验收的 Writer summary/findings/recommendations；
- 当前 source inventory 的字段、profile 与 data-quality 信号。

Planner 只做四类语义决策：未回答缺口、`reuse_entry/new_query`、确定性
evidence operations、requirement-to-view/rubric 覆盖。它不得读文件、运行
Bash、召回 Spec、查数或写产物；唯一允许的动作是一次
`structured_output`，且必须符合扩展动态附加的 typed schema。

通用规划规则：

- 同一 `fromCardId` 且能复用同一份明细或同一次 material query 的需求合并为
  一张 task；不要按展示切面重复派工。
- 已有字段能够完成投影、排序、TopN、分组、区间、基础统计、对比、分箱或样本内
  关联时使用 `reuse_entry`。字段必须逐字来自该卡 `availableFields`。
- 只有确实缺指标、维度/粒度、日期范围、筛选对象、对照或口径时才使用
  `new_query`，并给出 typed `evidenceGap` 与相应候选指标/维度。
  orderBy、分页或图表样式不是新查询理由。
- operations 必须最小且不重叠，每 task 最多六个；复杂复合问题仍须按同一
  `fromCardId` 合并为一张 task，不得为了绕过上限拆成重复同源 task；每个 requirement 都必须引用
  能实际支持其 capability 的 view，不能把相关性写成因果或显著性。
- capability 必须采用最具体的通用答案形态：记录排序用 `ranking`，分组或单驱动
  分箱用 `structural_breakdown`，两个驱动的平衡/权衡用 `joint_tradeoff`，相关性
  用 `association`。不得把这些降级成宽泛的 `record/comparison/distribution` 来
  绕过结构化事实要求。
- `correlation/quantileBins` 的 `fields` 只放驱动字段，不得重复
  `targetField`；相同 type、target、有效 binCount 与 where 的分析必须合并 fields，
  不能拆成重复 operation。
- `jointQuantileBins` 只接受恰好两个驱动字段，并在两个驱动与 target 的共同
  complete-case 样本上做二维等频分箱；按 `direction=desc|asc` 只把结果解释为
  最佳已观测组合。不得拼接两个边际最优，不得外推全局最优、因果或显著性，
  也不得插值或推断样本中未观察到的组合。固定脚本会生成 `decisionBrief`，直接
  给出支持合格候选、原始已观测赢家、最小支持数、边界与通用经营含义；Researcher
  原样提交 `recommendedClaim`，不再联查 `evaluation/grid` 或重新起草。低支持赢家必须披露 cell 样本量
  与最小支持规则，支持度合格的 cell 也只能作为明确标注的替代候选。
- 用户问题表达平衡、权衡、取舍或最佳组合时，非空明细必须至少有一个
  `capability=joint_tradeoff` requirement，并引用 `jointQuantileBins`；单条最大值、
  TopN 或两个边际最优都不能单独回答这类问题。“平衡/权衡/最好/最佳点”本身不
  等于用户要求日期、具体记录或排名；只有用户明确要求这些字面记录答案时，才增加
  `sort/topN/bottomN` 与 `ranking` requirement。
- 数据质量信号只约束本 task 实际使用的字段；需要排除时必须显式体现在 operation
  的 `where` 与 caveat requirement 中，不能静默删除记录。`where` 固定为
  `[{"field":"...","op":"eq|ne|gt|gte|lt|lte|in","value":...}]`；
  `in` 使用非空数组，其余 op 使用标量。
- Planner 必须按权威 R1–R7 词典选择 requirement 的 `targetRubric`，且无权降低
  动态门槛；新生成 requirement 省略 `minScore`，由下游固定按 2 验收。
- rubric 下限按证据能力区分：comparison/association 至少包含 R5；基础
  `stats/range` distribution 不自动强制 R3/R5，只选择它实际改善的 rubric；
  `groupBy/quantileBins/jointQuantileBins` 结构拆解至少包含 R3+R5；补指标或
  口径型 `new_query` 至少包含 R4。同一结构 view 上只解释完整性边界的
  `data_quality` requirement 不重复继承结构分析 requirement 的 R3/R5。
- 合法零行源继续使用 `reuse_entry`：只生成一个无字段、无 where 的
  `project`，requirements 只允许 `no_data/data_quality`；不能因为无法推断
  输出 schema 就升级为 `new_query`。
- `tasks: []` 不是自由文本捷径：仅当所有相关 Writer source 都已校验为零行，且
  每个 source 都有 typed `answerRequirements` 以 `coverage.kind=empty_source`
  覆盖 `capability=no_data` 时才允许。任何非空 Writer source（包括已有单行
  finding）都必须生成 B3 task；Writer finding 只作为编辑起点，不能绕过 B3。
  `noDeeperReason` 只作说明，不参与充分性判定。

#### B2.5.3 — 扩展自动提交

Planner 通过事件桥返回后，父扩展在首次写入前完成 schema 与 semantic validation，然后
一次性执行：

```text
typed plan
  → 确定性生成 analysis/tasks.json + analysis/main.md
  → prepare reuse_entry evidence
  → assemble report
  → b2 layout
  → finish B25_EDITOR
  → 自动启动 B3_RESEARCH
```

materializer 生成的 `main.md` 只含问题、范围、Writer 起点、待加深和固定的
`## 待 B3 Researcher 结论` 占位；Writer 起点只允许嵌入已验收且带
`entry.json#...` 证据的单条 finding，禁止复制明细行或样例表，不含
Markdown/HTML 表格。扩展把成功结果附加到第二个 bootstrap Bash 的 tool result，
并返回 `researchTasks[]`，其中每项包含完整
materialized `task` 与固定 `evidencePath`（`reuse_entry` 已生成，`new_query`
仅预留目标路径），以及
产物路径和 prepared evidence 摘要。自动 bootstrap 路径会根据首项生成精确调用，
并立即通过同一真实 pi-subagents 事件桥派发首个 Researcher；它的已校验结果与
Planner marker 一起附在第二个 bootstrap Bash 的 tool result。父模型不得再生成、
重复或改写首个调用，也不得重读 `tasks.json/main.md`；只处理 successor、剩余 task
或固定 finalizer。若 `researchTasks: []`，扩展改为给出唯一固定 B3 finalizer，并只
暴露 `bash`，不得伪造 Researcher。仅直接调试 Planner tool result 的兼容路径仍返回
精确 `NEXT_TOOL_ONLY`，不改变正常自动 bootstrap 的行为。

父代理禁止手工 `write/edit` tasks/main，禁止调用
`finalize-editor-stage.mjs`、拆分 prepare/assemble/layout，禁止手工
`stage-gate finish B25_EDITOR`。materialize、finalize、layout 或 Gate finish
任一步失败都会自动 fail，当前 attempt 不重试。

#### B2.5 清单

- [ ] 首条消息只有 Gate 指定的 status + source-fields
- [ ] 两个 Bash 都成功后，扩展事件桥只派发一次 fresh 单步骤 Planner；父模型未重复派发
- [ ] 非空任务时同一 bootstrap 自动派发且验收首个 Researcher，父模型未重复调用；空任务给出固定 finalizer
- [ ] 扩展已自动生成产物、通过 b2 layout、完成 B25 并启动 B3

成功后无需用户再回复“继续”。若 `researchTasks: []`，B3 不派 Researcher，
但仍走显式 no-op merge/layout/finish 计时；不得直接跳到 B4。

### B3.5 — Report Researcher（P3，有 pending 任务时必做）

**何时跑：** B2.5 Planner tool result 的 `researchTasks[]` 非空。
**何时跳过：** `researchTasks: []`，或用户明确只要草稿/不要加深。

#### B3.5.0 — report-researcher 前置（有 pending 时硬依赖）

Phase B3.5 **硬依赖** 已注册的 Pi SubAgent 运行时名 **`report-researcher`**（项目文件：`.pi/agents/report-researcher.md`，细则：`.agents/pi/skills/html-report/agents/report-researcher.md`）。

B0_PREFLIGHT 已经由扩展通过真实 pi-subagents 事件桥自动验证了
`report-writer`、`report-researcher`、`report-reviewer`、`report-designer`
四个运行时角色；只有四者全部存在时才允许完成 B0。因此进入正在运行的
`B3_RESEARCH` 后，Report Editor **不得再次调用** `action: "list"`，也不得重复
做 SubAgent discovery；本 Gate 的子代理调用只允许下方的
`report-researcher` 单步骤 chain。

如果 B0 已报告 `report-researcher` 缺失，或实际派发时运行时明确返回该角色
不可用，则 **停止 B3.5**（不要进入 B4 假装已加深），沿用下面的配置错误提示，**禁止**：
   - 用内置 `worker` / `delegate` 顶替
   - Report Editor 自己代写 `data/explore/*` 与 `explore-*.md` 冒充完成
   - 静默把 pending 改成 skipped 却声称「深度足够」

**用户提示（中文，须完整告知）：**

> ## 无法继续加深分析：未识别到 report-researcher SubAgent
>
> html-report B3.5 要求使用专用 agent **`report-researcher`**（按 task mode 解读固定 evidence；仅 `new_query` 自主构造查询并落盘探索数据；写紧凑探索章节），
> **不能**使用 Pi 内置 `worker` 替代。
>
> ### 请先配置
>
> 1. 确认仓库根下存在：`.pi/agents/report-researcher.md`（frontmatter `name: report-researcher`）
> 2. 确认 Pi 的 **cwd 为仓库根**，并已安装 **pi-subagents** 扩展。
> 3. **重启 Pi**，让扩展在新的 Gate attempt 自动重新验收 `report-researcher`。
> 4. 可选自检：`node .agents/pi/skills/html-report/scripts/check-report-agents.mjs`
> 5. 配置成功后，请回复「重试当前阶段」。

When this dependency is missing, after showing that prompt use the following
as the final standalone call and stop:

```bash
node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail \
  --session-dir "$SESSION" --stage B3_RESEARCH \
  --reason "report-researcher SubAgent is missing" --format text
```

#### B3.5.1 — 轮次循环

生成文档的 **`maxRounds = 2`**；轮次状态由扩展和 B3 finalizer 管理，
父代理不得为了读取轮次而重开 `tasks.json`。

每轮：

1. 使用 B2.5 Planner tool result 的 `researchTasks[]`。每项已包含完整
   materialized `task` 与固定 `evidencePath`；不要为收集 pending 再读
   `tasks.json/main.md`。
2. 若无 pending → 结束 B3.5。
3. 若当前 `round >= maxRounds` → 将剩余 pending 标为 `skipped`（`skipReason: "maxRounds"`），结束 B3.5。
4. 按 task mode 准备输入：
   - `reuse_entry`：B2.5 扩展已一次性生成并返回 evidencePath。
     B3 **不得**再次运行 prepare、读取 tasks/entry/meta 或搜索路径；直接使用
     handoff 中的完整 task 对象和已返回路径派发 Researcher。脚本已在本机读取完整
     entry、核对 CLI `rowCount + rowsSha256`，只写紧凑
     `$SESSION/analysis/evidence/<ID>.json`。不得让 Researcher 读完整 entry。
     字段预检会以 `EVIDENCE_FIELD_MISMATCH` **一次列全** `availableFields` 与
     `missingFields[]`，其中每项包含 requiredColumns / fields / where / sort /
     group 等全部引用位置。若仍不匹配，Editor 必须按这一个错误清单一次修正
     同一 task 的 `evidencePlan.requiredColumns/operations` 后最多重跑一次；
     不得逐错试跑，不得扫描目录、读取 entry/meta 或阅读脚本源码调试。这不是
     新查询理由。
   - `new_query`：不预生成 evidence。task 必须先有结构化
     单个 `evidenceGap.type` 或非空 `evidenceGap.types[]`，并有
     `evidenceGap.reason`；Researcher 只读取一次
     `result.json`，按 `fromCardId` 取得原卡 `requestBody` 作为基线，禁止读取
     Writer `entry.json` / `entry.meta.json`。唯一合法 Spec 召回命令是：

     ```bash
     bin/data-harness-cli wikis recall-debug \
       --question "<只描述 evidenceGap 的问题>" --json --doc-set specs
     ```

     只读返回 JSON 的 `contextFiles` 中与 gap 相关的 Spec。构造 payload 时只改
     gap 明确授权的指标/维度/日期或对照期/筛选范围/口径字段，其余原
     requestBody 日期、筛选、范围和口径保持不变。查询成功后运行同一固定证据
     脚本，再只读 evidence。若该脚本返回 `EVIDENCE_FIELD_MISMATCH`，Researcher
     直接返回一次结构化 `needs_evidence_plan`（带完整 `availableFields` 与
     `missingFields`）；禁止读取 explore 明细、扫描目录或在子代理内反复试错。

5. 按 task 逐个串行 spawn **`report-researcher` 单步骤 chain**，每任务一个；
   禁止 `tasks[]`、`chain[].parallel`，也禁止把多个 Researcher 混入同一条
   chain。正常自动 bootstrap 已由扩展事件桥派发首个 task；父模型不得再次调用。
   只有直接调试 Planner tool result 的兼容路径才原样执行机器生成的
   `NEXT_TOOL_ONLY`。首个 task 返回并通过父扩展契约校验后，才派发 successor 或
   `researchTasks[]` 中的下一 task，且不得手工拼装、重读 tasks/main/evidence。
`qdm-harness` 会按当前 SESSION 的 `tasks.json` 无条件覆盖固定
`outputSchema`、前台生命周期与 tool budget；不要手写 schema，也不要使用
自由文本 `agent: "report-researcher"` 调用。Researcher 的成功终态是一次
typed `submit_research_findings`；工具会提交同一结构化返回并终止子代理，父代理
不得要求它再调用 `structured_output` 或复制结果：

- `ranking` 只写用户明确要求的少量记录事实，不默认枚举完整 TopN；
- `joint_tradeoff` 按固定 `/views/<id>/decisionBrief` pointer 读取并原样提交
  `recommendedClaim`；不得添加题面范围数字、复制 JSON key、枚举值或无关协议元数据；
- `suggestedDeeper` 默认空，只有具体未覆盖缺口确需不同指标、维度、范围、对照或
  查询时才填写。

```text
subagent({
  context: "fresh",
  chain: [{
    agent: "report-researcher",
    task: `按 report-researcher 处理 taskId=<ID>
SESSION=<ABS>
result.json=<ABS>
完整 task 对象: <JSON>
用户问题: <…>
evidencePath=<ABS>/analysis/evidence/<ID>.json
机器契约：由 `qdm-harness` 根据当前 task、mode、requirements 和 outputSchema
注入；父代理不得在这里展开、转述或追加规则。`
  }]
})
```

其中 `evidencePath=<ABS>` 是机器协议行，必须逐字保留键名与 `=`；不得翻译成
“证据路径”、添加括注或改用其他分隔符。

**Spawn 参数必填：** `chain` 恰好一步 + `context: "fresh"` + 绝对路径。
`context` 必须位于 subagent 顶层、与 `chain` 同级；`chain[0]` 只放 `agent` 和
`task`，绝不能写成 `chain:[{..., context:"fresh"}]`。参数 schema 在扩展处理前
校验，层级错误会直接终止当前 Gate。
`完整 task 对象` 必须逐字使用 B2.5 tool result 中该项的 `task` JSON，包含
所有空数组、null 和状态字段；尤其不得省略 `evidenceGap`、
`candidateIndicators`、`candidateDims` 或 `status`。不要摘要、重排语义或手工挑
字段；扩展会在启动前做完整对象一致性校验，少一个空字段也会拒绝派发。
扩展返回的“已通过结构化返回与证据产物契约验证”JSON 才是唯一状态来源；
禁止解析 `.pi-subagents` artifact、acceptance report 或子代理自由文本。

若 `subagent` tool result 自身为 error/rejected（没有上面这段“已通过”文本），
这是当前 B3 attempt 的基础设施/契约终止事件：不得读取或编辑 `tasks.json`、
`main.md`，不得 assemble/layout，也不得把 task 手工降级为 failed 后继续。
`qdm-harness` 会在 tool result 末尾给出唯一允许的规范化
`stage-gate fail --stage B3_RESEARCH` 完整命令；逐字执行该命令并停止。不得自行
拼接 reason、先查 status、添加 `2>&1`/管道/重定向或尝试第二个命令。等待用户
明确回复“重试当前阶段”。

6. 处理 Researcher 的单个 JSON 返回时，不要读取 summary/section，不要 edit
   `tasks.json` / `main.md`，也不要手工 assemble/layout。父扩展已校验返回和落盘
   产物。所有 task 收齐后，B3.5.2 finalizer 会一次性完成这些机械步骤：
   - `status: "ok"`：保留结构化 JSON；若还有 task，直接派发下一 task。
   - `status: "needs_evidence_plan"`：源字段存在，只修正 operations、重新生成
     evidence 并重派；不得查数。字段不匹配返回必须从
     `evidenceGap.availableFields` 与 `evidenceGap.missingFields[].references`
     一次取得完整修复清单，不接受自由文本或逐字段报错。
   - `status: "needs_new_query"`：仅当 evidence 的 `availableFields/coverage`
     确认真实缺指标、维度、粒度、范围、对象、对照或口径时，Editor 把同一 task
     `evidencePlan.mode` 改成 `new_query`，写入结构化 `evidenceGap` 后重派。
   - `status: "failed"`：当前 B3 attempt 立即失败；不要编辑 task/main、不要
     assemble/layout，也不要重跑 Writer/Researcher。`qdm-harness` 会在 tool result
     末尾给出唯一允许的规范化 `stage-gate fail` 完整命令；必须逐字执行该命令，
     不得把结构化 `error` 改写为 `--reason`，不得先查 status，不得添加
     `2>&1`/管道/重定向。执行后立即停止并等待用户回复“重试当前阶段”。若 error 为 `INDICATORS_TIMEOUT` / `ETIMEDOUT` /
     `timeout` / `超时`，同一 task/query 尤其禁止换 child 再执行相同 payload。

7. **Report Editor B3.5 清单**（侧重 R3/R4/R5 + 是否推进 R1；**不做**全篇 14 分打分）：
   - 每个 `status: "ok"` 后标为 done 的 task 都有固定 evidence producer、source
     Hash、section 和 summary；`needs_*` / failed 不伪造完成产物；
   - `reuse_entry` 不得有本 task 的 `data/explore/*`，也不得召回/查数；
   - `new_query` 必须有结构化 evidenceGap、material `queryDelta`、合法 explore
     rowCount/Hash；除 gap 授权字段外，payload 必须保持原 requestBody 的日期、
     筛选、范围和口径；
   - `orderBy/currPage/pageSize/chartType` 或未知字段不能构成 material delta；
   - 分析非纯贴表；每个 `analysisRequirements[].id` 都由结构化
     `findings[]` 至少一项覆盖，且 finding 只能引用该 requirement 声明的 view；
   - `selfCheck` 只作线索，不能替代 requirement coverage 的机器校验；
   - **Fail gate** → `failed` or rewrite pending and re-spawn **Researcher** (not Writer)
   - **禁止** layout fail 后 `mkdir`/`cp`/手写 `data/explore/*` 刷绿
8. 不手工更新 main；finalizer 删除 Editor-only「待加深分析」，使用已校验的短
   summary 替换固定占位为用户可读「核心结论」，再由 `assemble-report.mjs` 按
   done task 唯一、确定性追加 Researcher section。深入分析排在全量数据之前，
   Writer/new_query 全量表统一进入「数据附录」。
9. 当前调试链不因 `suggestedDeeper` 自动扩张任务；它仅作为后续建议保留，避免
   在同一 Gate 引入未计划的额外查询。
10. finalizer 统一执行 `round += 1` 并写回 `tasks.json`。
11. 进 B4 前：题面是否已有数据支撑的直接答案？R1 仍弱且轮次未满 → **再开下钻 task**，不要把首次深度发现甩给 Report Reviewer。

#### B3.5.2 — 布局校验

After all Researcher rounds (including a no-op `tasks: []` run), run exactly
one deterministic finalizer. It validates the persisted Researcher returns,
marks tasks done, increments the round, replaces the fixed main placeholder,
assembles the report, and runs the authoritative explore layout:

```bash
node .agents/pi/skills/html-report/scripts/finalize-research-stage.mjs \
  --result "$SESSION/result.json"
```

Do not separately read summary files, edit tasks/main, assemble, or run layout;
those duplicate model turns are forbidden. The B2.5 assembly is not final
because Reviewer must scan the post-Researcher report produced here.

- 对每个 version 2 done task，两种 mode 都要求 evidence + section + summary；
  只有 `new_query` 要求 explore data/meta，`reuse_entry` 反而禁止同 task explore 文件。
- `assemble-report.mjs` 复用 Writer 全量表，并从 `new_query` explore JSON
  自动插入完整探索表，同时按 done task 自动插入 Researcher section；Editor
  不复制 section，Researcher 不手工复制全量数据。
- `tasks: []` 时本 phase 可过（warning only）。
- The explore layout also fingerprints the current `analysis/main.md` against
  `report/render-manifest.json`; stale pre-Researcher assembly fails.

The exact finalizer above is the parent model's final standalone B3 tool call.
`qdm-harness` binds it to the current Session, Gate attempt and `toolCallId`,
persists a no-replay reservation, and automatically runs `finish B3_RESEARCH`
only after the finalizer succeeds. The parent must not call `stage-gate finish`
itself. A finalizer error or result-binding mismatch automatically fails the
current B3 attempt and cannot be retried within that attempt.

The extension-owned B3 Gate text must show **Editor**, **Researcher**, combined
stage, and cumulative execution durations. In step mode return it and stop;
enter B4 only after the user's next **“继续”**.

### B4 — Report Reviewer (P4) + Editor repair loop

Follow `agents/report-reviewer.md` + **`docs/html-report-quality-rubric.md`**.
Goal: **legal quality pass**. 动态模式随后进入 Report Designer HTML；固定推荐调试模式
则在 B4 pass 后自动跳过 B5，止于 Markdown + quality 产物（not default `--force`）。

`B4_REVIEW` runs **one Reviewer/repair attempt per Gate attempt**.
`maxRepairRounds = 2` (Editor-owned). Append each attempt to
**`$SESSION/quality/repair-log.json`** (must 落盘). A failed verdict must stop
at a failed Gate; repair work only starts after the user replies
**“重试当前阶段”** and the extension starts the next timed attempt.

```json
{
  "version": 1,
  "maxRepairRounds": 2,
  "rounds": [
    {
      "at": "ISO-8601",
      "pass": false,
      "total": 12,
      "diagnosis": ["INVENTED_METRIC", "R4_LOW"],
      "actions": ["rewrite_section:<card-id>", "spawn_researcher:<task-id>"]
    }
  ]
}
```

For the current Gate attempt:

1. On a retry attempt, first execute the previously logged repair actions. If
   they change sections, explore results or `analysis/main.md`, re-run
   `assemble-report.mjs` before Reviewer. On the first attempt, continue.
2. **Spawn Reviewer as one structured chain step** (do not write verdict
   yourself). `qdm-harness` owns and replaces the exact `outputSchema`,
   foreground lifecycle and tool budget; do not hand-write a schema and do not
   use a free-text `agent: "report-reviewer"` call:

```text
subagent({
  context: "fresh",
  chain: [{
    agent: "report-reviewer",
    task: `B4 scorecard for SESSION=<ABS_SESSION>
result.json=<ABS_RESULT_JSON>
The B3 report is already assembled and frozen; do not run assemble-report.mjs.
1) First tool batch: quality-scan.mjs --result <ABS_RESULT_JSON> plus optional sibling reads
   of frozen result/report/render-manifest/rubric in any source order. Wait for
   scan success before reading scan.json; do not include submission in this batch.
2) read scan.json once, then call submit_review_scorecard exactly once with typed
   R1–R7 scores (0–2), notes, summary, structured issues and repairHints. Do not
   pass paths/pass/total/max/timestamps/fingerprint or serialized JSON. The tool
   owns safe draft serialization, verdict stamping, dynamic target-rubric gates
   derived from completed tasks, and quality/report.md rendering. Score from the
   report evidence; never inflate a score merely to satisfy a task target.
3) wait for tool success, then copy its returned object unchanged to structured_output;
   parent extension performs authoritative phase-quality layout
If scan/read/submit fails: do not retry or continue scoring; return the strict
status=infrastructure_error branch with pass=false, total=0, failedStep, verbatim error,
and at least one actionable repairHint. A normal status=failed also requires a
non-empty repairHints array.
FORBIDDEN: hand-write draft/report/verdict; run write-verdict.mjs; re-assemble;
child layout; 0–7/49 score scales; edit main to force pass`
  }]
})
```

Only the extension text “已通过结构化返回与落盘 verdict 契约验证” followed
by its JSON is authoritative. `status=passed` is possible only with
`pass=true`; a completed stamped verdict with `pass=false` uses `status=failed`.
In addition to the base threshold, the stamped verdict may expose
`requiredRubrics` and `gateFailures`: these are derived from completed task
`targetRubric` / `analysisRequirements[].targetRubric`, never from business
field names. Any unmet declared minimum keeps `pass=false` and enters the same
repair loop.
`status=infrastructure_error` means scan/read/write/stamp stopped before a
scorecard and must terminate the current Gate attempt immediately. Never
interpret a generic acceptance report or “steps completed successfully” as a
quality pass.

**Infrastructure terminal branch (handle before the normal pass/fail steps):**
do not run quality layout, do not append a semantic quality repair round, and do
not re-spawn Reviewer in the same Gate attempt. Use `failedStep`, `error`, and
`repairHints` from the structured JSON, then make this the final standalone
call and stop:

```bash
node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail \
  --session-dir "$SESSION" --stage B4_REVIEW \
  --reason "Reviewer infrastructure_error at <failedStep>: <short error>" --format text
```

After the upstream artifact/tool problem is corrected, only the user's
**“重试当前阶段”** starts a new Gate attempt.

3. 不要再次手工运行 `check-session-layout --phase quality`。父扩展在接受
   Reviewer structured return 之前已经 authoritative 地运行该校验（含 assembled
   `report/report.md`、full-table manifest、verdict producer/fingerprint 与 Gate
   前置状态）；只有校验通过才会返回上面的“已通过…契约验证”文本。
4. If **`pass: true`**: keep the already assembled `report/report.md`; do **not** copy `analysis/main.md` over it. Make this the final standalone call:

   ```bash
   node .agents/pi/skills/html-report/scripts/stage-gate.mjs finish \
     --session-dir "$SESSION" --stage B4_REVIEW --format text
   ```

   In step mode return the timing text and stop. B5 starts only after the next
   **“继续”**.
5. If **`pass: false`** and repair rounds remain:
   - Use only the extension-returned JSON fields `diagnosis.codes`,
     `diagnosis.hardBlockers`, `diagnosis.issues`, and `repairHints`. Do **not**
     read/scan `quality/*`, sections, Writer rows, or `.pi-subagents` after the
     Reviewer returns; the parent hook blocks those duplicate diagnostics.
   - **Diagnose and plan** (do not execute the repair until the retry approval):
     | Signal | Action |
     | --- | --- |
     | `INVENTED_METRIC` / 模拟列 | Report Editor 修正 `main.md`：移除无法指回 `entry.json` 的主张；若缺真实指标，再创建 Researcher task |
     | Need a genuinely missing metric | **Report Researcher** assignment to fetch the required field |
     | Any dynamic target rubric below its declared minimum | Repair the corresponding requirement or create a Researcher drill task |
     | True `DATA_UNTRACEABLE` | Fix narrative or re-fetch; do not force HTML |
   - Append **`quality/repair-log.json`**
   - Then use the following as the final standalone call, return the failure
     timing/reason and stop. Ordinary “继续” is rejected:

     ```bash
     node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail \
       --session-dir "$SESSION" --stage B4_REVIEW \
       --reason "quality verdict failed: <short codes>" --format text
     ```
   - After **“重试当前阶段”**, execute the logged repair and repeat from step 1,
     including a **new** Report Reviewer. Never hand-edit `verdict.json` to pass.
6. If still failed after **2** repairs: append the final failure, call
   `stage-gate fail` once more, and stop auto-fix. **`--force` HTML only if the
   user explicitly agrees**; ordinary “继续” remains blocked.

Hard = unreconcilable numbers or invented metrics. Only literal entry rows or
Researcher data may reconcile a claim; do not treat an ad-hoc SUM as a business total.

**Editor 绝对禁止：** `write`/`edit` `$SESSION/quality/verdict.json`。唯一合法路径是 Reviewer 调用 typed `submit_review_scorecard`，由该工具内部安全序列化并复用盖章逻辑。

### B5 — Report Designer (P5, after quality pass)

Only when `verdict.pass === true` and `report/report.md` exists.

**固定推荐调试模式（`HTML_REPORT_A_CONFIG_MODE` 为 `fixed` 或未设置）：** B5 不属于
本轮设计验收。qdm-harness 会在 B4 通过后的批准/自动推进中直接完成 `B5_DESIGN` 并显示
“已自动跳过” Gate 消息。父代理不得派发 `report-designer`，也不得运行
`compile-report-content.mjs`、`compose-report.mjs`、`capture-report.mjs`、
`finalize-design.mjs` 或 `check-session-layout --phase html`。不要补造 HTML、截图、
`render.meta.json` 或 `design-result.json`；调试模式的完成结果只交付
`report/report.md` 和 `quality/*`。

以下 Designer 流程**仅适用于动态推荐模式**（`HTML_REPORT_A_CONFIG_MODE=dynamic`）：

**Report Editor must spawn**:

```text
subagent({
  context: "fresh",
  chain: [{
    agent: "report-designer",
    task: `B5 autonomous design
SESSION=<ABS>
result.json=<ABS>
Run compile-report-content.mjs -> create report.design.html once with exactly one literal HTML_REPORT_CONTENT slot -> immediately compose-report.mjs -> capture-report.mjs for desktop/mobile -> inspect and internally repair (max 2) -> finalize-design.mjs -> layout --phase html.
report.content.html is context only; never copy or inline it because compose-report.mjs is the sole content inserter. Before first capture and both screenshot reads, never edit or rewrite the template. Do not use render-report.mjs, edit report content, read Wiki/data, inspect script source, search paths, or ask for intermediate approval. Finish with one structured_output result.`
  }]
})
```

`qdm-harness` replaces the caller schema and lifecycle with the fixed Designer
contract: one foreground chain, fresh project context, `acceptance.level=none`,
the current SESSION's five absolute output paths, and one `structured_output`.
Do not hand-write a schema, use the free-text top-level `agent` form, or request
changed-files/tests/acceptance evidence. The Editor waits for this existing
Designer run; never start a duplicate Designer in the same Gate attempt.

Only extension text “已通过结构化返回、固定产物与 phase-html layout 契约验证”
followed by its JSON is authoritative. The parent extension has already checked
all fixed files, screenshots, and `check-session-layout --phase html`; do not
read those files or run layout again. A validated `status=failed`, a missing
structured result, or an invalid artifact terminates this Gate attempt; never
re-dispatch Designer automatically. On failure use this as the final standalone
call and stop:

```bash
node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail \
  --session-dir "$SESSION" --stage B5_DESIGN \
  --reason "Designer or HTML layout failed: <short reason>" --format text
```

On success, make this the final pipeline tool call:

```bash
node .agents/pi/skills/html-report/scripts/stage-gate.mjs finish \
  --session-dir "$SESSION" --stage B5_DESIGN --format text
```

Return the final completion timing plus absolute HTML and screenshot paths.
There is no further approval after B5.

### Phase B bans

- inject-template
- Numbers without `$SESSION/data/**`
- Confirm smoke as sole analysis data
- Changing confirmed `result.json` skeleton
- Artifacts outside `$SESSION`
- Builtin `worker` for any `report-*` agent
- Missing any of the four agents in list at B0
- Editor writing sections / explore / verdict / HTML to bypass agents
- **Hand-writing** Writer `entry.json` / `entry.meta.json`, design stamps, or editing `quality/verdict.json` to pass layout
- `mkdir` + `cp` + forge JSON after `check-session-layout` fails
- Re-spawning Writer for depth (use Researcher)
- Full R1–R7 scoring outside B4
- Advancing to B5 without a **new** Reviewer pass after repairs
- 固定推荐调试模式下派发 Designer，或生成/伪造 B5 HTML、截图和设计签章

### Layout gates (must be `ok: true` before next stage)

| After | Command | Provenance required |
| --- | --- | --- |
| B2 Writer | `--phase writer` | `entry.json` + minimal `entry.meta.json` pairs; no profile/facts, sections, tasks or main |
| B2.5 | `--phase b2` | Writer data pairs + Editor tasks/main |
| B3.5 | `--phase explore` | 两模式均验 evidence producer/source Hash；仅 new_query 验 material explore；fresh assembly |
| B4 | `--phase quality` | approved prior step Gates + assembled `report.md` + verdict producer/fingerprint |
| B5（动态模式） | `--phase html` | approved B4 Gate + exact compiled content + stamped desktop/mobile visual pass |
| B5（固定推荐调试） | 不执行 | 扩展自动完成；仅保留 approved B4 Gate + Markdown/quality 产物，不要求 HTML 产物 |

On layout fail: **re-spawn the responsible agent**; do not forge gate files.

---

## Reference

- Full design: `docs/html-report-pipeline.md`
- Quality rubric (R1–R7 + stage checklists + drill-down loop): `docs/html-report-quality-rubric.md`
- Session layout and contracts: pipeline §4–§6
- Provenance scripts: `fetch-entry.mjs` / `prepare-research-evidence.mjs` / `fetch-explore.mjs` / `write-verdict.mjs` / `check-session-layout.mjs`
