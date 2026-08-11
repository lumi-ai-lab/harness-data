# html-report 全流程方案（落档）

更新时间：2026-07-24（Asia/Shanghai）

> 本文档固化 **配置闭环 + 报告生成** 的完整设计，避免上下文压缩后方案丢失。
> **已实现：P0–P5（含 P3 Report Researcher）+ 默认单步调试 Gate**。

---

## 1. 两阶段总览

### 阶段 A — 配置确认（已完成）

```text
用户问题
  -> [A_CONFIG 计时]
  -> Spec 召回（--doc-set specs）
  -> recommendations.json
  -> 本地 HTML 预填选中
  -> [A_CONFIG Gate：finish 后停止计时]
  -> 用户确认
  -> 逐卡 CLI 冒烟（--single-page）
  -> result.json 落盘
```

### 阶段 B — 报告生成（建设中）

```text
用户回 Pi：「生成报告」
  -> [B0_PREFLIGHT Gate] result/session + 四个 report-* agent（扩展确定性执行，不启动父模型）
  -> 读 result.json
  -> [逐卡串行单步骤 chain] Report Writer 调用 fetch-entry：入门 CLI **全量分页**取数 + --meta → data/cards/<id>/
  -> Report Writer：返回仅含单行事实的简短分析与定性建议（不写报告章节、不做统计/排序/跨行推导）
  -> [B2_WRITER Gate] entry/meta 数据对校验
  -> [B25_EDITOR] status + source-fields → fresh report-researcher Planner（内部角色 report-editor-planner）
  -> typed plan → 扩展确定性生成 analysis/tasks.json + analysis/main.md → reuse evidence → assemble + b2 layout
  -> 非空任务：同一扩展事件桥立即派发首个 Report Researcher（父模型不再照抄调用）
  -> [轮次≤2~3] Report Researcher：reuse_entry 只读固定 evidence；仅 new_query 定向召回相关 Spec + material 查询；证据充分且 status=ok 才写紧凑分析（P3）
  -> main 只更新跨任务总结；assemble 自动追加 done Researcher section 后重建最终报告
  -> Report Reviewer：对照 data/** 门禁（P4）
  -> Report Designer：内容编译 → 自主前端设计 → 双视口截图验收 → report.html（P5）
```

### 1.1 默认单步调试 Gate

所有新 html-report Pi session 默认 `step`，状态持久化到：

```text
$SESSION/debug/pipeline-state.json
```

人工 Gate 顺序为 `A_CONFIG → B0_PREFLIGHT → B2_WRITER →
B3_RESEARCH → B4_REVIEW → B5_DESIGN`。`B25_EDITOR` 独立计时但不额外等待
用户，在 B3 Gate 同时展示 Editor 与 Researcher 耗时。

每个阶段严格执行 `start（扩展启动）→ 工作 → layout → finish/fail →
stop`。成功后仅用户精确回复「继续」才批准并启动下一阶段；失败仅接受
「重试当前阶段」。Gate 等待和 pause 时间单独记录，不计入阶段与累计执行
耗时。`stage-gate finish/fail` 必须是该阶段最后一个、独立且不并发的工具
调用。

A_CONFIG 获批进入 B0 时是一个确定性例外：输入钩子直接执行真实 runtime
list、phase-a layout 与 B0 finish/fail，再通过 `html-report-gate` custom message
显示 Gate 文本并返回 `handled`，不启动父模型。该输入只完成 B0，用户必须另发
一条「继续」才能批准 B0 并启动 B2。自测以 custom `message_end` 的结构化
Session/阶段/attempt 绑定作为完成信号，不等待不存在的 `agent_settled`。

等待批准时，qdm-harness 扩展只放行 `read/grep/find/ls` 和
`stage-gate status`；`bash/write/edit/subagent` 等推进工具会被硬阻断。子代理
使用自己的 Pi session id，不读取父会话 Gate。

临时逃生开关：`HTML_REPORT_GATE_MODE=auto`，或在当前 session 回复
「关闭单步调试并继续」。自动模式仍记录计时，但 layout 不要求批准记录。

---

## 2. 锁定决策

| 主题 | 决策 |
| --- | --- |
| 入口 skill | 仅 `html-report`，不新开用户可见第二 skill |
| Template | 本路径 **不注入、不召回** template |
| 确认时 CLI | **冒烟**（single-page），证明配置可执行 |
| 报告取数 | 再取；HTML/`result.json` 中的 CLI = **入门命令** |
| 入门取数分页 | **必须拉全部分页**，禁止只取一页（不要加 `--single-page`） |
| 取数重试 | 最多 **3 次**，间隔 **5 秒** |
| 入门失败策略 | **单卡失败标注，不阻断其它卡** |
| 加深分析 | `reuse_entry` 只解读固定 evidence；仅带结构化 evidenceGap 的 `new_query` 可从原 requestBody 做最小 material 查询 |
| 主产物 | 先 Markdown，质检通过后再 HTML；**不要 PPT** |
| 质量 | 专用 Report Reviewer Sub-agent；首版不接完整 report-quality 系统 |
| 确认后触发 | 用户说 **「生成报告」**（或等价）后继续 |
| 最大探索轮次 | 默认 **2**（可配置 2～3） |
| 契约子代理编排 | Writer / Researcher / Reviewer 均逐卡或逐 task 串行；每次一个独立单步骤 chain；禁止 `tasks[]` 和 `chain[].parallel` |
| 每卡执行 | **独立 Report Writer SubAgent**（含仅 1 卡）；内调 fetch 脚本，返回初步分析 |
| 调试 Gate | 新 session 默认 `step`；`auto` 仅作为临时逃生模式 |

---

## 3. 角色：脚本 vs 持久化 Sub-agent

| Display | `name` | 职责 | 形态 |
| --- | --- | --- | --- |
| **Report Editor** | — | 阶段编排、消费 typed handoff、决定是否进入下钻 | 主会话 `SKILL.md` |
| **Report Writer** | `report-writer` | 单卡取数 + 单行事实/定性建议返回；不做统计、排序或跨行推导 | Pi agent + `agents/report-writer.md` |
| **Report Researcher** | `report-researcher` | B2.5 以短 Planner 模式做语义规划；B3 解读紧凑 evidence，只有真实缺口才召回 Spec + 新查 | Pi agent + `agents/report-researcher.md` |
| **Report Reviewer** | `report-reviewer` | R1–R7 终审打分；typed scorecard 工具安全落盘并与 structured return 强绑定 | Pi agent + `agents/report-reviewer.md` |
| **Report Designer** | `report-designer` | 前端设计、响应式与截图验收 | Pi agent + `html-report-design` Skill |
| Data/render scripts | — | 取数、内容编译、合成、签章 | deterministic scripts |
| Reviewer finalize | — | typed scorecard → draft / stamped verdict / quality report | `submit-review-scorecard.mjs`（内部复用 `write-verdict.mjs`） |

**B0：** list 须同时含四个 `report-*` agent。取数脚本非 LLM；Writer 用 `--card-id` 隔离每卡产物，但父流程仍逐卡串行派发。

### 证据链 / 防伪造门禁（producer）

| 产物 | 合法 `producer` | 校验阶段 |
| --- | --- | --- |
| `data/cards/*/entry.json` + `entry.meta.json` | `fetch-entry.mjs` / CLI `--meta` | writer+ |
| `analysis/evidence/*.json` | `prepare-research-evidence.mjs`（绑定源 rows Hash + operation plan） | explore+ |
| `data/explore/*.meta.json` | `fetch-explore.mjs`（仅 `new_query`；须含 `attempts[]`、rowCount/Hash、material queryDelta） | explore |
| `report/render-manifest.json` | `assemble-report.mjs` + main/report hashes | explore+ |
| `quality/verdict.json` | `write-verdict.mjs` + `scanFingerprint` 匹配 `scan.json` | quality / html |
| `report/render.meta.json` | `compose-report.mjs` + content/template hashes | html |
| `report/design-result.json` | `finalize-design.mjs` + screenshot/HTML hashes | html |

- bare `qdm-indicators-cli`、手写 Writer 数据文件、Editor 手改 verdict **过不了** `check-session-layout`。
- Reviewer 必须：`quality-scan` → 读 scan → `submit_review_scorecard` typed object → 原样 structured return；禁止模型手写 JSON。
- Report Editor **禁止** 写 `quality/verdict.json` 或 `data/explore/*` 冒充通过。
- `reuse_entry` Researcher 只能读取一次固定 evidence，并各写一次固定 section/summary；
  Bash、完整 entry、临时脚本、Markdown 样例表和 evidence 中不存在的数字都会被
  child guard / structured return / layout 三层拒绝。
- `new_query` Researcher 只允许任务授权的 Spec recall、固定 fetch-explore 与固定
  evidence prepare 命令；字段不匹配一次性返回结构化 gap，不在子代理内猜字段重试。

---

## 4. Session 目录约定

**唯一合法根目录：**

```text
.harness/state/html-report/<session-id>/   # 记为 SESSION
```

Phase B 所有产物必须写在 `SESSION` 下。
**禁止**写入仓库根目录 `analysis/`（曾发生过 Agent 相对路径写错）。

```text
.harness/state/html-report/<session-id>/
  recall.json
  recommendations.json
  page-state.json
  server-meta.json
  result.json                      # 阶段 A 输出 / 阶段 B 输入
  debug/
    pipeline-state.json            # Gate 状态、attempt、执行/等待计时、批准记录
  data/
    cards/<card-id>/
      entry.json                   # CLI --meta 的 rows
      entry.meta.json              # 仅 rowCount、rowsSha256
    explore/<task-id>.json         # 仅 P3 new_query；fetch-explore 写 rows
    explore/<task-id>.meta.json    # 仅 new_query；producer + rowCount/Hash + queryDelta
  analysis/
    evidence/<task-id>.json        # 固定脚本生成的紧凑证据；不复制完整明细
    sections/explore-<task-id>.md  # Report Researcher
    sections/explore-<task-id>.summary.json
    main.md                        # B2.5 materializer 生成骨架；B3 finalizer 合并结论
    tasks.json                     # B2.5 typed plan 确定性编译的深入任务清单
  quality/                         # P4
    scan.json                      # quality-scan.mjs 机械扫描
    verdict.draft.json             # typed tool 用 JSON.stringify 写入的 Reviewer 评分草稿
    verdict.json                   # write-verdict.mjs 最终结论（producer + fingerprint）
    report.md                      # 质检叙述
    repair-log.json                # Editor 修复轮次（建议）
  report/                          # assemble 后、P4/P5 使用的最终交付源
    report.md                      # main + Writer/new_query 全量明细（assemble-report.mjs 生成）
    render-manifest.json           # cards/tasks 的来源、行数、Hash 与 fullTable
    design-input.json              # 编译后的紧凑设计 brief + 内容 hashes
    report.content.html            # 不可修改的语义正文
    report.design.html             # Designer 所有的页面骨架/CSS/交互
    report.html                    # compose-report.mjs 最终单文件 HTML
    render.meta.json               # 内容/模板/HTML fingerprints
    visual-check.json              # capture-report.mjs 双视口截图元信息
    design-result.json             # finalize-design.mjs 视觉验收签章
    screenshots/*.png
  run-meta.json
```

校验命令：

```bash
# B2 Writer 产物（不提前要求 tasks/main）
node .agents/pi/skills/html-report/scripts/check-session-layout.mjs \
  --result .harness/state/html-report/<session-id>/result.json \
  --phase writer

# B2 分析产物
node .agents/pi/skills/html-report/scripts/check-session-layout.mjs \
  --result .harness/state/html-report/<session-id>/result.json \
  --phase b2

# P3 Report Researcher（两模式均须 evidence+section；仅 new_query 须 data/explore）
node .agents/pi/skills/html-report/scripts/check-session-layout.mjs \
  --result .harness/state/html-report/<session-id>/result.json \
  --phase explore

# P4 质量门禁（含 B2 + quality/*）
node .agents/pi/skills/html-report/scripts/check-session-layout.mjs \
  --result .harness/state/html-report/<session-id>/result.json \
  --phase quality

# P5 HTML（含 quality + report.html）
node .agents/pi/skills/html-report/scripts/check-session-layout.mjs \
  --result .harness/state/html-report/<session-id>/result.json \
  --phase html
```

---

## 5. `result.json` 契约（输入）

最低要求：

- `status === "confirmed"`
- `session_id`、`title`、`mode`
- `cards[]`：每卡含 `id`、`title`、`analysisFocus`、`requestBody`（及可选 `cli`）
- `validation[]`：确认时冒烟记录（可选参考，**不能替代全量取数**）

`requestBody` 中常见 `pageSize`/`currPage`：
**FETCH 全量模式忽略「只取一页」语义**，由 CLI 默认 **all-pages** 拉齐（或不传 `--single-page`，必要时规范化 pageSize≤5000）。

---

## 6. FETCH 全量分页规则（重点）

HTML / `buildRequest` 可能带 `currPage` + `pageSize`（例如 500），确认冒烟用 `--single-page`。

报告取数 **禁止** `--single-page`：

```bash
qdm-indicators-cli analysis execute \
  --payload-json '<normalized requestBody>'
  # 默认 all-pages，直到拉完
```

规范化建议：

1. 使用卡片 `requestBody` 为底稿。
2. **不要**加 `--single-page`。
3. `pageSize` 若缺失或过大，按 CLI 上限处理（默认/封顶 5000）。
4. `currPage` 对 all-pages 模式无「只取该页」含义；可保留 1 作为起始。
5. CLI `analysis execute --meta` 一次返回完整 `rows`、`rowCount`、`rowsSha256`；适配脚本将 rows 写为 `entry.json`，并将后两项写为 `entry.meta.json`。不生成 profile/facts 或任何汇总。

重试：只有明确的瞬时 CLI 错误且单次在 15 秒内返回时，才 sleep 5s 后重试，
最多尝试 3 次；CAS、等待与全部 CLI 尝试共享 540 秒硬预算。超时、鉴权、参数、
永久 HTTP 错误或返回契约错误均立即终止。同一卡/同一 Researcher task fingerprint
在一个 Gate attempt 内只允许派发一个子代理，schema/结构化返回失败也不得自动
换 child 重跑；只有用户明确「重试当前阶段」生成新 attempt，或 Editor 实质修改
Researcher task 后才可重新派发。若此前已成功落盘，新 attempt 会在复算
`rowCount + rowsSha256` 并校验产物不早于当前 confirmed `result.json` 后直接复用
entry/meta，不鉴权、不重复查数。仍失败则该卡
`status: failed`，继续其它卡。

---

## 7. 编排细节

### 7.1 用户触发

确认 HTML 成功后，用户在 **同一或后续 Pi 对话** 说「生成报告」等。
Report Editor：定位 session（`PI_SESSION_ID` 或 `result.json` 路径）→ 校验 `status=confirmed` → 进入 B。

### 7.2 P2 最小路径（每卡 Worker + 汇总）

0. **B0：** 扩展通过真实 pi-subagents 事件桥自动执行一次 runtime list，并验收四个 `report-*` Agent；step 模式由 input hook 确定性回显 Gate，不启动父模型。缺失时自动 fail，**禁止** `agent: "worker"` 顶替。
1. B2 启动时只暴露 `bash` 并执行当前 Session 的精确 `stage-gate status`。若模型在同一消息多生成 sibling 工具，扩展阻止 sibling 且不执行、不终止已在途的合法 status；status 成功后只暴露机器生成的精确首个 Writer `subagent(...)`，参数漂移继续被阻止，直到接棒完成。
2. Report Editor 对每张卡逐个串行 spawn **`report-writer` 单步骤 chain**（1 卡也 spawn 1 个）；每次只含一张卡，禁止 `tasks[]`、`chain[].parallel` 或把多个 Writer 混入同一 chain。按 `agents/report-writer.md`：
   - `fetch-entry.mjs --result … --card-id <id>` → entry/meta（CLI `--meta` 三字段契约）
   - 不写章节或报告；只回报 Report Editor：数据/元信息绝对路径 + 带 JSON Pointer 的单行事实、定性建议；不做统计、排序、极值、趋势或跨行推导
   - qdm-harness 强制注入精确 output schema 和前台运行边界；同一卡在每个 Gate attempt 只派发一次，任何失败均不自动换 child 重跑；用户明确重试产生新 attempt 后，合法 entry/meta 自动复用
3. `check-session-layout --phase writer`；只检查成功 Writer 的 entry/meta 对且拒绝 profile/facts，随后完成 B2 Gate。
4. 用户批准后进入独立计时的 B2.5：第一条消息只运行 Gate 指定的 `stage-gate status + prepare-research-evidence.mjs --source-fields`；inventory 由扩展缓存并绑定当前 `result.json`，父模型不得重新列举或读取 Writer 的 entry/meta 目录。
5. 两个 bootstrap Bash 都成功后，qdm-harness 不再等待父模型复述固定调用，而是直接通过真实 pi-subagents 事件桥只派发一次 fresh、单步骤 `report-researcher` Planner；`stage-gate status` 仍真实执行且不可省略。扩展注入用户问题、查询范围、已验收 Writer 返回和 source inventory，并固定使用已验证的一次性 typed-tool 模型；这个角色级模型选择不依赖题目、门店、指标或字段，普通 B3 Researcher 不受影响。Planner 不读文件、不召回、不查数、不写文件，只返回一次 typed plan。同源需求必须合并为一张 task，单 task 最多六个最小且不重叠的 operations，不得拆分重复同源 task；已有明细可完成的排序/TopN/分组/统计走 `reuse_entry`，真实缺指标、维度、粒度、范围、对象、对照或口径才走带 typed `evidenceGap` 的 `new_query`。答案 capability 必须采用最具体的通用形态（如 ranking、structural_breakdown、joint_tradeoff、association）；平衡/权衡类问题必须由 `joint_tradeoff + jointQuantileBins` 提供二维结构证据，不能用一个最大值或两个边际最优代替。只有全部相关 Writer source 均为已校验零行，并逐源提供 typed `empty_source -> no_data` 覆盖时，才允许 `tasks: []`；任一非空 source 都必须进入 B3。
6. 扩展先规范化可证明无歧义的 typed plan 表示，再执行严格校验并确定性生成 version 2 `tasks.json` 与紧凑 `main.md`（**不得出现 Markdown 表格或复制任何 Writer 行的日期/数值**）。例如，仅当 operation 键集合精确、原始 `fields` 唯一且未超限时，才可从 driver 列表删除单个重复的 `targetField`；额外键、重复值、超限或删除后 arity 不合法仍失败。随后自动准备 reuse evidence、assemble、执行 b2 layout、finish B25 并启动 B3。成功结果返回完整 `researchTasks[]`；非空时从首项机器生成精确调用，并直接通过同一真实 pi-subagents 事件桥派发、验收首个 Researcher，其 marker/结果附在原 bootstrap tool result，省去父模型照抄回合。若 tasks 为空，则给出唯一固定 B3 finalizer 并只暴露 `bash`，不伪造 Researcher。父模型禁止手写/重读 tasks/main、重复或重构首个调用、手工 B25 finalizer/finish 或失败重派。
7. 所有 Researcher task 完成后，父模型只运行一次扩展给出的精确 B3 finalizer。finalizer 合并 main、重新 assemble 并通过 explore layout 后，qdm-harness 依据 Session + Gate attempt + toolCallId 的持久预留自动 finish B3 并进入原有人工 Gate；父模型不得再调用 `stage-gate finish`。finalizer 失败或结果身份不匹配会自动 fail，当前 attempt 禁止重试。后续质量扫描、Reviewer 和 HTML 只使用这个最终版本。

### 7.2.1 analysisFocus 契约

- `recommendations.json` 每卡 **必须** 非空 `analysisFocus`（`validate-config` 校验）。
- HTML 确认提交时若仍为空，页面会用标题生成默认 focus，写入 `result.json`，避免 Phase B 无写作 brief。

### 7.2.2 范围 filters 契约（门店/区域/品类）

- 用户问题点名具体门店/区域/品类时，Agent 必须写入 **`cards[].filters`**（结构化 dim + values）；只写在 title/analysisFocus 文案或顶层自定义字段 **不算** 完成。
- `validate-config`：若 **全部卡片** 无有效 filter，只打 **warning**（stderr），**不** exit 1（全量范围查询合法）。
- HTML 确认：任一张卡仍无有效 filter 时 **弹窗二次确认**（用户可取消补条件，或坚持全量后继续）。
- **不**用脚本从自然语言猜店号并硬拦（避免误伤与反复失败）。

### 7.2.3 推荐卡时间与去重

- 每卡 `startDate`～`endDate` **含首尾 ≤ 31 天**；未指定时间默认 **当月 1 号～昨天**（例：7/20 → 7/1～7/19）。更长周期在 `warnings` 说明截断，更长分析留给 P3。
- `validate-config` 对跨度 > 31 天 **error**。
- **禁止**同指标集合 + 同 filters、仅日/周/月粒度不同的多卡；能 1 张说清则不要硬凑 3 张。

### 7.3 P4 Report Reviewer 门禁（已落地 · Report Reviewer）

1. `assemble-report.mjs` 已生成最终 `report/report.md` 与 `render-manifest.json`
2. `node .../quality-scan.mjs --result <result.json>`（优先扫描最终 report.md，而不是只扫描 analysis/main.md）
3. Report Reviewer（`agents/report-reviewer.md`）按 **`docs/html-report-quality-rubric.md`** 对 **R1–R7 逐项 0–2 打分**，调用一次 `submit_review_scorecard`；工具写：
   - `quality/report.md`（含评分表）
   - `quality/verdict.json`（`draft: false`；`scores` + `total`；hard 一票否决）
4. Reviewer 返回时由父扩展自动执行唯一一次 authoritative
   `check-session-layout --phase quality`（校验 assembled report、manifest、scores）；
   Reviewer 子代理和 Editor 都不重复运行
5. pass → 完成 B4 Gate；fail → 写 repair-log 后 `stage-gate fail`，等待用户「重试当前阶段」才修复并重跑 Reviewer
6. **不**在 fail 时进入 P5 HTML
7. **仅 B4 全量打分**；B2/B3 用分阶段短清单（见母表）

### 7.4 P3 Report Researcher 往复（已落地 · 有问题则下钻）

1. B2.5：短上下文 **Editor Planner** 返回 typed plan；扩展确定性生成 version 2 `tasks.json`、`main.md` 和 `researchTasks[]` handoff，不重跑 report-writer。
2. `researchTasks[]` 非空时，自动 bootstrap 已经通过扩展事件桥派发并验收首个 **`report-researcher`**；父模型禁止重复它，只按 Planner 返回的 `researchTasks[]` 串行处理 successor 或剩余 task。仅直接调试 Planner result 的兼容路径仍原样执行精确 `NEXT_TOOL_ONLY`。B0 已验收运行时，B3 不再 list，也不重读 tasks/main。空任务直接执行扩展给出的固定 finalizer。该 finalizer 成功后由扩展自动 finish B3 并保留人工 Gate，父模型不再生成收尾命令或解释性回合。
3. `reuse_entry`：B2.5 扩展已按唯一一次 `--source-fields` 清单生成紧凑 evidence；Researcher 只读该 evidence，不召回、不查数、不读完整 entry。字段不匹配时脚本以 `EVIDENCE_FIELD_MISMATCH` 一次返回全部 `availableFields + missingFields[].references`，不得逐字段试错。
4. `new_query`：必须已有结构化的单个 `evidenceGap.type` 或非空
   `evidenceGap.types[]`，并有 `reason`。Researcher 只读
   一次 `result.json`，按 `fromCardId` 取原卡 `requestBody`，禁止读取 Writer
   entry/meta。唯一 Spec 召回命令是：

   ```bash
   bin/data-harness-cli wikis recall-debug \
     --question "<只描述 evidenceGap 的问题>" --json --doc-set specs
   ```

   只读返回 `contextFiles` 中与 gap 相关的 Spec；payload 只修改 gap 授权部分，
   其余日期、筛选、分析范围和指标口径保持原 requestBody 不变。
   `fetch-explore` 硬校验 material delta；查询后再经固定 evidence 脚本，模型不读
   完整 explore。
5. 证据充分时 Researcher 写紧凑分析 + **selfCheck**；`needs_*` 只返回 gap、由 Editor 修 plan/升级；完整 Writer/explore 表由 `assemble-report.mjs` 自动插入。
6. Report Editor 先更新 task 状态；main 只更新跨任务总结、不复制 section；assemble 自动追加 done section，再做一次最终 layout。真实缺口可把同一 task 升级为 `new_query`。

### 7.5 P5 HTML（已落地）

1. 前置：`quality/verdict.json` 为 `pass: true` 且 `assemble-report.mjs` 已生成 `report/report.md`
2. Editor 只 spawn 一次 `report-designer`；Designer 不继承项目上下文或普通扩展，只注入 `html-report-design`。
3. Designer 单次自治运行：
   - `compile-report-content.mjs`：MD → 不可修改语义内容 + design brief；
   - 创建 `report.design.html`：负责页面骨架、CSS、响应式、交互与打印；
   - `compose-report.mjs`：确定性注入语义内容；
   - `capture-report.mjs`：1440x1000 + 390x844；内部最多修复两轮；
   - `finalize-design.mjs`：把视觉判断签章到当前 HTML/截图。
4. `check-session-layout --phase html` 重新校验内容、模板、HTML、截图 fingerprints 与 full-table markers。
5. 向用户给出 HTML 和截图绝对路径。

`render-report.mjs` 不再处于正常路径，只保留显式 fallback。内容正确性由脚本保证，视觉设计由隔离的 Designer SubAgent 决定。

---

## 8. 实施分期状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 本文档 + HANDOFF 对齐 + agents 骨架 | 已落地 |
| P1 | `fetch-entry.mjs` 全量分页 + 测试 | 已落地 |
| P2 | Writer 最小取数契约 + SKILL 报告阶段 | 已落地（CLI `--meta` / analysis return / tasks / layout） |
| P3 | Report Researcher + tasks 往复 | **已落地**（reuse/new-query evidence + material fetch + mode-aware layout） |
| P4 | Report Reviewer（scan + reviewer + 父扩展 authoritative quality layout） | **已落地** |
| P5 | Designer Skill + compile/compose/capture/finalize + HTML gate | **已落地** |

---

## 9. 相关路径

- Skill：`.agents/pi/skills/html-report/SKILL.md`
- FETCH：`.agents/pi/skills/html-report/scripts/fetch-entry.mjs`
- FETCH-Report Researcher：`.agents/pi/skills/html-report/scripts/fetch-explore.mjs`
- 固定 Research evidence：`.agents/pi/skills/html-report/scripts/prepare-research-evidence.mjs`
- Researcher 返回契约：`.agents/pi/skills/html-report/scripts/researcher-return.mjs`
- Researcher 子进程工具门禁：`.agents/pi/extensions/report-researcher-guard/`
- Report Reviewer scan：`.agents/pi/skills/html-report/scripts/quality-scan.mjs`
- Report Reviewer typed finalize：`.agents/pi/skills/html-report/scripts/submit-review-scorecard.mjs`
- Reviewer 返回契约：`.agents/pi/skills/html-report/scripts/reviewer-return.mjs`
- HTML content/compose：`compile-report-content.mjs` / `compose-report.mjs`
- Visual QA：`capture-report.mjs` / `finalize-design.mjs`
- Designer Skill：`.agents/pi/skills/html-report-design/SKILL.md`
- Stage Gate：`.agents/pi/skills/html-report/scripts/stage-gate.mjs`
- Gate 扩展控制：`.agents/pi/extensions/qdm-harness/gate-control.mjs`
- Layout：`.agents/pi/skills/html-report/scripts/check-session-layout.mjs`（phases: a / writer / b2 / explore / quality / html）
- Agents：`.agents/pi/skills/html-report/agents/*.md`；Pi 注册：`.pi/agents/report-writer.md`、`report-researcher.md`
- 质量母表：`docs/html-report-quality-rubric.md`（R1–R7、分阶段清单、**有问题则下钻**）
- 交接：`HANDOFF-html-report.md`
