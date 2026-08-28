---
name: html-report
description: Generate an html-report (阶段 A 配置确认 + 阶段 B 报告生成) in the current WorkBuddy session. Use when the user asks for a report, 报告, html-report, 周例会报告, 经营分析报告, or similar.
---

# HTML Report（阶段 A + 阶段 B 都在本会话完成）

当用户要生成 html-report 时，由你在本会话内推进阶段 A（默认打开 `qdm-metric-cli ui`
让用户确认配置；`--phase-a agent` 可动态切回本会话构建 result.json）和阶段 B
（推进 Stage Runner 生成报告）。阶段 A 的 UI 流程对齐 PI html-report 流水线；
阶段 B 由 Runner 派生 codebuddy 子会话执行。Gate 状态由 Runner 唯一 owner，写
`.harness/state/html-report/<session>/debug/pipeline-state.json`。

所有命令从仓库根运行。本 skill 只通过薄入口命令推进；不要直接读写 Gate 状态文件。
WorkBuddy 会对 html-report 首轮和同会话「继续」类提示自动跳过通用 QDM Harness recall；
这对齐 PI html-report 默认路径（先开 `qdm-metric-cli ui`，不让模型先读召回文档，也不让模型生成 `result.json`）。

交互纪律：每次运行 `start` / `advance` / `status` 后，必须立即把命令输出中的
URL、错误摘要、报告文件路径或“下一步”转述给用户；不要只说“后台在跑”，也不要让用户
反复询问状态。若输出提示“不要后台继续推进”或当前停在 `B2_MAIN`，必须停下等用户确认。

## 阶段 A — 配置确认（默认打开 qdm-metric-cli ui，用户保存 result.json）

1. 启动会话并打开 `qdm-metric-cli ui`（幂等，重复运行无害）：
   `node .agents/workbuddy/scripts/html-report-workbuddy.mjs start --session <id> --phase-a ui --question "<原问题>"`
   - `--question` 把原问题持久化到 `<session>/debug/a-config-question.json`，供 result.json
     缺 `userQuestion` 时回填；请把你收到的用户原问题原样传入。
   - 命令会初始化 A_CONFIG Gate，并拉起 `qdm-metric-cli ui`（自动打开浏览器，监听
     127.0.0.1；用户点「保存」写出 `<session>/result.json`）。输出里会给出监听地址。
   - `qdm-metric-cli ui` 是 `commandAdmin` 命令：要求 `QDM_AUTH_BLOB` 指向同时具备
     `qdm.metric.query` 与 `qdm.admin` 的 blob。本地 `config/dev-auth.blob` 只有 query
     权限，会 `AUTHORIZATION_FAILED`（code 77）。真实运行时由 Host 注入鉴权可忽略；
     本仓库手工调试先 `export QDM_AUTH_BLOB=<具备 qdm.admin 的 blob 文件>` 再 start。
2. **不要**在本会话构建 result.json：把监听地址和下面的指引告诉用户，让用户在打开的
   `qdm-metric-cli ui` 里搭卡，点击 **保存** 写出
   `.harness/state/html-report/<session>/result.json`，然后回到会话回复「继续」。
   「保存」不会自动进入阶段 B；必须先得到用户「继续」。
3. 用户「继续」后推进（`A_CONFIG` 读取 result.json，要求 `status === "confirmed"`；
   `B0_PREFLIGHT` 逐卡真实 `analysis execute`，通过后自动进 B2_WRITER → B2_MAIN）：
   `node .agents/workbuddy/scripts/html-report-workbuddy.mjs advance --session <id>`

4. 动态开关「agent 解析问题并构建 result.json」这一步：默认 `--phase-a ui` 已关闭该步
   （直接用 UI 生成 result.json）；调试/自动化需要时用下面命令重新启用 agent 路径：
   `node .agents/workbuddy/scripts/html-report-workbuddy.mjs start --session <id> --phase-a agent`
   agent 模式步骤：
   - 用公开命令发现指标与维度（不需要鉴权；hook 不为它们注入鉴权，**不要**加
     `--data-auth`/`--auth-blob`/`--auth-json`）：
     - `qdm-metric-cli metric search --keyword <关键词>` —— 找指标 code
     - `qdm-metric-cli wikis --code <metricCode>` —— 公式、统计口径、可用维度
     - `qdm-metric-cli dim search --metric <metricCode>` —— 该指标可用维度
     - `qdm-metric-cli dim values --code <dimCode> --keyword <词> --limit <n>` —— 解析维度值/展示名
     数值、排名、对比、阈值必须来自这些命令输出，禁止估算或编造。
   - 按 `docs/html-report-pipeline.md` §5 契约构建 `result.json`，写入
     `.harness/state/html-report/<session>/result.json`（**禁止**写到仓库根 `analysis/`）。
     顶层：`{ "status": "confirmed", "session_id", "title", "mode", "userQuestion", "cards": [...], "validation": [...] }`。
     每张卡只保留一个 `query` 对象：
     `{ "id", "title", "headingLevel", "analysisFocus", "chartType": "table", "indicatorBizId", "query": { "request": {...}, "comparisons": ["YOY", "MOM"] } }`。
     `query.request` 是唯一查询真源，结构必须与 qdm-metric-cli `QueryRequest` 严格一致
     （`additionalProperties: false`）：
     `{ "metrics": [...], "statisticPolicy": "SUMMARY"|"SALES_STORE_DAY_AVG", "time": { "startDate", "endDate" }, "dimensions": [...], "filters": {}, "pageNo": 1, "pageSize": 500 }`。
     载荷文件**不要**包一层 `{"request": ...}`；卡片**不要** `requestBody`/`queryProof`/`cli` 等旧字段。

5. 推进时注意：
   - `A_CONFIG` 读取 `result.json`，要求 `status === "confirmed"`，否则先让用户保存/补写 result.json 再 advance。
   - `B0_PREFLIGHT` 用运行时鉴权 blob 对每张卡执行真实 `analysis execute`。本会话 hook 只为
     `analysis execute` / `auth describe` 注入鉴权；**不要**单独调用 `analysis validate`
     （hook 不绑定鉴权，会得到 `AUTHORIZATION_FAILED`）。任一卡取数失败会 fail Gate 并给出
     精确契约违规（如 `filters` 不支持某维度、`pageSize` 超限）。按报错修卡后：
     - 若失败阶段仍是 `B0_PREFLIGHT`，先恢复当前 Gate：
       `node .agents/pi/skills/html-report/scripts/stage-gate.mjs retry --session-dir "<projectRoot>/.harness/state/html-report/<session>" --phrase "重试当前阶段"`，再运行 `advance`。
     - 若失败阶段是 `B2_WRITER` 单卡失败，再使用：
       `node .agents/workbuddy/scripts/html-report-workbuddy.mjs retry --session <id> --task <cardId>`。
     - 不要在 `B0_PREFLIGHT` 阶段使用 `retry --task`；当前薄入口只支持 B2_WRITER 单卡重试。
6. 需要时关闭 UI 服务（避免孤儿进程）：
   `node .agents/workbuddy/scripts/html-report-workbuddy.mjs stop --session <id>`

## 阶段 B — 报告生成（止于 B2_MAIN）

7. `B0_PREFLIGHT` 通过后 Runner 自动进入 `B2_WRITER`；继续 `advance` 会以低并发派生 codebuddy
   子会话取数并写 `caption.md`（默认并发 4，可用 `HTML_REPORT_WRITER_CONCURRENCY=<1-8>` 调整），再进入 `B2_MAIN` 生成 `analysis/main.md`，finish 后停在人工
    Gate（`awaiting_approval`，Runner 不自动批准）。此时 `analysis/main.md` 就是本流程的
    交付物，`advance` / `status` 输出会包含“报告文件”路径；查看状态后必须把该路径提示给用户，
    再把报告呈现给用户：
    `node .agents/workbuddy/scripts/html-report-workbuddy.mjs status --session <id> [--format text|json]`
8. 当前版本到此为止：**不要**推进到 `B25_EDITOR` / `B3_RESEARCH` / `B4_REVIEW` / `B5_DESIGN`
   （深研、质检、最终 HTML 属后续增强，推进会在 `B25_EDITOR` 停止）。如用户明确要求继续，再
   `node .agents/workbuddy/scripts/html-report-workbuddy.mjs approve --session <id>` 推进并如实报告结果。
9. 任一阶段失败时按报错修复后重试当前阶段；自动阶段（`A_CONFIG`→`B0_PREFLIGHT`→`B2_WRITER`→`B2_MAIN`）
   成功时 `advance` 会级联推进，无需逐条调用。需要中止时 `cancel --session <id>`。

## 参考

- 完整流水线设计：`docs/html-report-pipeline.md`
- 薄入口 / Runner 用法：`.agents/workbuddy/README.md`，脚本在 `.agents/workbuddy/scripts/`
- 查询契约：`packages/html-report-kernel/src/query/metric-query-contract.mjs`
