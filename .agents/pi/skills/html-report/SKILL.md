---
name: html-report
description: Open qdm-metric-cli ui for the user to save result.json, then orchestrate report generation (no template inject).
---

# HTML Report

The original user question appears after the closing `</skill>` tag in Pi's expanded prompt. Use only that trailing text for recall/configure; never include this file's instructions in the question.

There are **two phases**. Phase A ends after the user clicks **保存** in
`qdm-metric-cli ui` (writes `$SESSION/result.json`) **and** replies **「继续」**
to pass the A_CONFIG Gate. The extension then runs B0 automatically; a passing
B0 closes `qdm-metric-cli ui` and enters B2 Writer in the same turn, while a
failure leaves the UI open and stops at the Gate.

Full architecture (P0–P5) is locked in:

`docs/html-report-pipeline.md`

## 阶段 A 默认路径（先不做推荐）

当前默认 A_CONFIG **不生成 `recommendations.json`**，也不打开
`public/local-report-builder.html`。扩展在模型开始前拉起：

```text
qdm-metric-cli ui --session-local-dir $SESSION
```

用户在该页面自己搭卡，点击 **保存** 写出 `$SESSION/result.json`。
**保存不会自动进入阶段 B。** 用户必须回到 Pi 回复 **「继续」**，A_CONFIG
Gate 确认 `result.json` 存在后才会批准进入 B0。

B0 通过后，扩展会停止本地 `qdm-metric-cli ui` 服务并进入 B2；浏览器标签页不会
自动关闭。B0 失败时 UI 保持可用，用户可以直接修正并重试。

- A_CONFIG 的 UI 启动和 runtime agent list 都由扩展在模型开始前完成。
  runtime list 仍走真实 pi-subagents runtime discovery，并按 Session/Gate attempt 写入
  `$SESSION/debug/runtime-agent-list/` 审计文件。
- Agent 不得再次调用 `subagent({ action: "list" })`、`stage-gate status`，也不得
  写 `recommendations.json`、启动 `server.mjs` 或检查 Session 目录。看到 completed
  Gate 后立即原样返回并停止，等待用户点「保存」后再回复“继续”。
- 仅 `html-report` 技能调用会关闭 Harness recall；同一 Pi 进程中的普通非技能问题仍保留
  原来的召回行为。
- **B5 当前仍跳过**：该默认 Session 在 B4 通过后由扩展自动完成 `B5_DESIGN`，
  不派发 `report-designer`。本轮最终业务产物是已通过 B4 的 `report/report.md` 与
  `quality/*`。
- 旧的模型写推荐 / `server.mjs` 路径仅在显式
  `HTML_REPORT_A_CONFIG_MODE=dynamic` 时保留；当前不要走那条路。

## Pi runtime prerequisite — extension-owned (hard stop)

This skill currently supports the **Pi Agent runtime only**. Before the parent
model starts Phase A, qdm-harness emits an in-process pi-subagents slash bridge
request with exactly `{ action: "list" }`. The extension binds the response to
the current Session and Gate attempt and verifies the four report agents.
Canonical runtime names are `qdm-html-report.report-writer`,
`qdm-html-report.report-researcher`, `qdm-html-report.report-reviewer`, and
`qdm-html-report.report-designer`; legacy bare `report-*` names still satisfy
the same check.

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
> 1. Preferred: `pi install npm:@lumi-ai-lab/pi-html-report`, then restart Pi.
> 2. Or run `pi config` and enable the `npm:pi-subagents` extension (installed but
>    filtered/disabled is still unavailable), keeping the four files under
>    `.pi/agents/` (legacy project mode).
> 3. Restart Pi from the workspace root.
> 4. Then reply **「重试当前阶段」**; the extension will run the runtime list again
>    for the new Gate attempt.

## Mandatory stage Gate and timing

The qdm-harness extension initializes every new html-report Pi session in
`step` mode unless `HTML_REPORT_GATE_MODE=auto`. Persistent state lives at:

```text
$SESSION/debug/pipeline-state.json
```

There are human Gates plus skippable later stages. Each stage has `enabled`
(run or skip) and `gate` (wait for 「继续」or auto-advance). Current first
slice:

| Order | Timed stage | Human stop | Default |
| --- | --- | --- | --- |
| 1 | `A_CONFIG` | yes | on |
| 2 | `B0_PREFLIGHT` | no; failure only | on; pass auto-advances |
| 3 | `B2_WRITER` | no | on; journalists fetch then caption |
| 4 | `B2_MAIN` | yes | on; `compose-main.mjs` writes `analysis/main.md`; optional sibling HTML |
| 5 | `B25_EDITOR` | no | **off** until later slices |
| 6 | `B3_RESEARCH` | yes | **off** |
| 7 | `B4_REVIEW` | yes | **off** |
| 8 | `B5_DESIGN` | final | **off** |

For runner-owned Phase B stages, the mandatory order is:

```text
extension starts stage → parent calls html_report_run_stage once →
Stage Runner performs work + validation + finish/fail → parent returns Gate text → stop
```

- In `step` mode, after a human Gate return the exact timing text from the tool
  and stop. Only the user's exact reply **“继续”** starts the next stage.
- `B2_MAIN` is an extra exception: after `analysis/main.md` is written, HTML is
  optional. Exact replies **“生成 HTML”** / **“重试 HTML 生成”** export
  `analysis/main.html` via the extension; **“继续”** or **“暂不生成 HTML”** skip
  HTML and finish B2_MAIN. Never write HTML, never call `md2html` or Bash.
- Auto mode never auto-exports HTML. The user can still say **“生成 HTML”**
  after B2_MAIN has completed.
- A failed Gate only accepts **“重试当前阶段”**. Ordinary “继续” cannot skip it.
- HTML conversion failure does not fail B2_MAIN; the user may retry or skip.
- In `auto` mode successful stages advance without approval.
- **“关闭单步调试并继续”** switches the current session to auto mode.
- Never call `approve`, `retry`, `resume`, `status`, `finish` or `fail` yourself.
  qdm-harness owns those transitions and exposes only
  `html_report_run_stage()` while Phase B work is running.

---

## Phase A — 配置确认（打开 qdm-metric-cli ui）

**Goal:** Open `qdm-metric-cli ui` so the user can assemble cards and click **保存**.
**Do not** generate `recommendations.json`. **Do not** open
`public/local-report-builder.html`. **Do not** collect business numbers here.

### A workflow

The extension has already started `A_CONFIG`, created

```text
$SESSION = <repo>/.harness/state/html-report/$PI_SESSION_ID
```

and launched:

```bash
qdm-metric-cli ui --session-local-dir "$SESSION"
```

`qdm-metric-cli ui` 的生命周期绑在当前 Pi Session：Session 退出或 Pi 进程退出
时，扩展会停掉这个 UI。不要再手工 `detach` 一份孤儿进程。

The parent model must **not** re-run that command, write recommendations, start
`server.mjs`, or call `stage-gate finish`. After the injected Gate text, stop
and deterministically display the listen URL plus these instructions in Pi:

1. 在打开的 `qdm-metric-cli ui` 里改卡。
2. 点击 **保存**，写出 `$SESSION/result.json`。
3. 回到 Pi 回复一次 **「继续」**。保存本身不会开始阶段 B。
4. B0 预检通过后自动进入 B2 Writer；只有失败才停在 Gate。

The extension refuses A→B0 approval until `$SESSION/result.json` exists. After
approval it injects `userQuestion` from the original skill prompt if the file
omits it, runs B0, and starts B2 automatically when B0 passes.

### Phase A bans

- Writing `recommendations.json`
- Starting `server.mjs` / `public/local-report-builder.html`
- Full multi-page report data collection
- inject-template
- Inventing metric values in chat
- Calling `stage-gate finish/fail` yourself in the default A_CONFIG path
- Treating 「保存」 as approval to enter B0 / B2

### Phase A checklist

- [ ] `qdm-metric-cli ui` opened
- [ ] User clicked **保存** → `$SESSION/result.json` exists
- [ ] User replied **「继续」**
- [ ] A_CONFIG approved → B0_PREFLIGHT
- [ ] B0 passed → B2_WRITER automatically

---

## Phase B — 生成报告（用户确认之后）

**Trigger:** user says **生成报告** / continue report / similar, with a confirmed `result.json`.

In step mode the extension only starts `B0_PREFLIGHT` after A_CONFIG is
approved and `result.json` exists. Never jump directly to Writer work.

The parent session is the Report Editor only at the user/Gate boundary. qdm-harness
owns all Phase B role invocation and artifact transitions:

| Role | Technical id | Stage Runner responsibility |
| --- | --- | --- |
| Report Writer | `report-writer` | Per-card fetch, caption and Writer artifact validation |
| Report Researcher | `report-researcher` | B2.5 planning and B3 evidence tasks |
| Report Reviewer | `report-reviewer` | B4 R1–R7 scorecard and stamped verdict |
| Report Designer | `report-designer` | Dynamic-mode B5 HTML and visual QA |

### Parent duties

- Call only the exact `html_report_run_stage()` injected by the current Gate. Do not pass reservation, agent, task, or stage.
- Return completed/failed Gate text and stop at human boundaries.
- Never impersonate a `report-*` role, reconstruct its task, or write its artifacts.
- Never substitute builtin `worker` / `delegate`.
- Treat `docs/html-report-quality-rubric.md` and `docs/html-report-pipeline.md` as
  Stage Runner/Agent implementation references, not parent-side tool instructions.

### Session root（强制路径，禁止写错）

Let `SESSION` = directory that contains `result.json`, always:

```text
.harness/state/html-report/<session-id>/
```

The Stage Runner resolves this directory from the current Pi Session and keeps
all Phase B artifacts under it. The parent must not derive paths, scan this
directory, or issue Phase B read/write commands.

### B0 — four Report SubAgents gate (hard dependency)

This is a second extension-owned runtime check after the startup prerequisite;
the A_CONFIG result is never reused for B0.

Phase B requires these **Pi** agents (registry under `.pi/agents/`):

| Display | `name` |
| --- | --- |
| Report Writer | `qdm-html-report.report-writer` (legacy `report-writer`) |
| Report Researcher | `qdm-html-report.report-researcher` (legacy `report-researcher`) |
| Report Reviewer | `qdm-html-report.report-reviewer` (legacy `report-reviewer`) |
| Report Designer | `qdm-html-report.report-designer` (legacy `report-designer`) |

**Before any fetch / analysis**, qdm-harness automatically emits one new
`{ action: "list" }` request through the real pi-subagents event bridge. It
validates all four names, the confirmed input/session and `phase=a` layout, then
finishes or fails B0 deterministically in the A_CONFIG approval input hook. In
`step` mode a passing B0 immediately starts B2 Writer and keeps the same turn
alive. A failed B0 writes the exact `html-report-gate` custom message with
`triggerTurn:false` and stops before any fetch.

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
> 1. Preferred: `pi install npm:@lumi-ai-lab/pi-html-report` then restart Pi
> 2. Legacy: files under repo root `.pi/agents/report-writer.md` 等四个
> 3. Pi **cwd = workspace root**, pi-subagents installed
> 4. **Restart Pi** so Extension / Agent registry reload
> 5. 修复后回复「重试当前阶段」；扩展会在新 attempt 自动重新验收

Only when the input/session check passes and the automatic list has **all four**
does the extension finish B0. B0 has no success approval stop: the same A_CONFIG
approval turn continues directly into `B2_WRITER`. A failed B0 remains fail-closed
and only accepts **“重试当前阶段”**.

### B1–B5 — qdm-harness stable stage runner

从 `B2_WRITER` 开始，父模型不再编排 Writer、Planner、Researcher、Reviewer 或
Designer 的外部调用参数。当前 running Gate 会只注入一个无参入口：

```text
NEXT_TOOL_ONLY：html_report_run_stage()
```

父模型必须把该调用作为下一条消息的唯一工具调用。不要传 reservation、agent、
task、schema 或 stage；不得读取 Session 推导参数。当前 running Gate attempt 由
qdm-harness 内部绑定。

```text
父模型
  │ html_report_run_stage()
  ▼
qdm-harness Stage Runner
  ├─ B2_WRITER：逐卡 Writer → entry/meta/caption 验收 → B2_MAIN
  ├─ B25_EDITOR：source inventory → Planner → materialize → B3
  ├─ B3_RESEARCH：Researcher/successor → finalizer
  ├─ B4_REVIEW：scan → Reviewer → verdict/layout
  └─ B5_DESIGN：固定模式跳过；动态模式 Designer → HTML/layout
```

Stage Runner 内部负责 capability probe、pi-subagents 版本适配、结构化返回、产物
验收、layout 与 Gate `finish/fail`。父模型不得直接调用 `subagent`、阶段脚本、
finalizer、assemble、compose、quality scan 或 layout 来代替它，也不得读取
`.pi-subagents` 临时目录。

#### Tool result handling

- `status=completed`：原样返回工具结果中的 Gate 文本并停止。需要人工 Gate 时，等待
  用户下一次回复 **「继续」**。
- `status=failed`：原样说明失败并停止。当前 Gate 只接受用户回复
  **「重试当前阶段」**；父模型不得在同一 attempt 重派、fallback 或修补 durable
  marker。
- B2 caption 校验失败会 fail 当前 attempt，不开放父模型手工 waive/edit 旁路。
- `B25_EDITOR` 成功后可在同一个 Stage Runner 调用中继续完成自动启动的
  `B3_RESEARCH`；父模型不得插入中间工具。
- 固定推荐调试模式由扩展自动完成 `B5_DESIGN`，只交付 Markdown 与 quality 产物；
  动态模式才运行 Designer 与 HTML 验收。

#### Durable no-replay

Stage Runner 在发出子任务前写入内部 attempt-bound reservation，并将物理 transport
生命周期持久化到：

```text
$SESSION/debug/contract-runtime/
  dispatches/
  settlements/
  stage-runs/
  researcher-tasks/
  reviewer-terminals/
  b3-finalizers/
```

`EMITTED → STARTED → TERMINAL` first-terminal-wins。只有 correlated、pre-start 的
`invalid_request` 可以重新探测并最多切换一次版本 adapter；一旦 `STARTED`，以及
超时、取消、Pi 重启或已有 running marker 时，均禁止 replay。用户批准重试后会
产生新的 Gate attempt 和新的 reservation。

### Phase B bans

- 直接调用 `subagent` 编排任何 `report-*` Agent
- 手工调用 `stage-gate status/finish/fail` 推进 runner-owned 阶段
- 手工运行 source-fields、finalizer、assemble、compose、quality scan 或 layout
- 读取 `.pi-subagents`、扫描 Session 目录或从临时自由文本恢复结果
- 修改 confirmed `result.json` 骨架
- 在 `$SESSION` 外写报告产物
- 使用 builtin `worker` / `delegate` 顶替任何 `report-*` Agent
- 手写 Writer entry/meta/caption、Researcher evidence/section、Reviewer verdict 或
  Designer HTML/截图/签章来绕过验收
- 在 B2_MAIN 手写 `analysis/main.html`，或直接调用 `md2html` / Bash 做 HTML 导出
- 同一 attempt 重派、timeout 后 fallback，或把旧 attempt 的迟到结果用于新 attempt

### Stage-owned artifacts

| Stage | Stage Runner 验收的权威产物 |
| --- | --- |
| B2 Writer/Main | `data/cards/*/entry.json`、`entry.meta.json`、`caption.md`、`analysis/main.md`；可选同级 `analysis/main.html`（用户明确同意后由 `export-main-html.mjs` 生成，不是 P5 Designer HTML） |
| B2.5 | `analysis/tasks.json`、materialized `analysis/main.md`、prepared evidence |
| B3 | Researcher evidence/section/summary、最终 `report/report.md` 与 render manifest |
| B4 | `quality/scan.json`、stamped `quality/verdict.json`、`quality/report.md` |
| B5 动态模式 | compiled content、`report.html`、render metadata、desktop/mobile screenshots、design result |
| B5 固定模式 | 扩展自动 skip；保留 approved B4 Markdown 与 quality 产物 |

任何返回只有在 qdm-harness 同时验收结构化值和对应持久化产物后才有效；子代理自由
文本、acceptance report 或临时 artifact 不能推进 Gate。

---

## Reference

- Full design: `docs/html-report-pipeline.md`
- Quality rubric (R1–R7 + stage checklists + drill-down loop): `docs/html-report-quality-rubric.md`
- Session layout and contracts: pipeline §4–§6
- Provenance scripts: `fetch-entry.mjs` / `prepare-research-evidence.mjs` / `fetch-explore.mjs` / `write-verdict.mjs` / `check-session-layout.mjs`
