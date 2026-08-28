---
name: html-report
description: Open qdm-metric-cli ui for the user to save result.json, then generate analysis/main.md (first version, optional sibling HTML at B2_MAIN).
---

# HTML Report (Codex CLI / ChatGPT App)

This skill drives the html-report pipeline through a local MCP server.
It works on **both Codex CLI and ChatGPT Desktop App** — no `codex` binary
required on the production path.

The MCP server exposes six tools. Call them in order:

```
html_report_start          → create session, open qdm-metric-cli ui
html_report_next           → advance pipeline (B0 preflight → B2 per-card fetch)
html_report_close_ui       → optionally close the editor without deleting session data
html_report_submit_writer  → submit caption for the current card
html_report_generate_html  → optional analysis/main.md → sibling main.html
html_report_status         → query current state
```

## Pipeline (first version)

```
A_CONFIG        user builds cards in qdm-metric-cli ui → saves result.json
  ↓ user replies "继续"
B0_PREFLIGHT    validate result.json + metric CLI (no PI Agent check)
  ↓ on pass, close qdm-metric-cli ui and auto-advance
B2_WRITER       per card: fetch-entry → prepare evidence → host writes caption
  ↓ submit_writer per card
B2_MAIN         compose-main → analysis/main.md
  ↓ ask whether to generate HTML; only then html_report_generate_html
optional HTML   export-main-html → analysis/main.html (same directory)
```

Stops at `B2_MAIN`. No B25/B3/B4/B5, no P5 Designer HTML. Sibling `main.html`
is optional and only after explicit user confirmation.

## How to use

### 1. Start

Call `html_report_start` with the user's question:

```json
{ "sessionId": "<unique-id>", "userQuestion": "<the user's original question>" }
```

The MCP server creates a session directory and opens `qdm-metric-cli ui`.
Tell the user:

1. In the opened `qdm-metric-cli ui`, build/edit cards.
2. Click **保存** to write `result.json`.
3. Come back here and reply **继续**.

**Do not** proceed until the user replies **继续**.

### 2. Advance

After the user replies **继续**, call `html_report_next`:

```json
{ "sessionId": "<the-id-from-start>" }
```

The server validates `result.json` (B0). On a successful preflight it closes
`qdm-metric-cli ui`, then fetches the first card's data and returns compact
evidence views. If B0 fails, the UI stays open so the user can correct it.
The browser tab itself is not closed automatically.

If the user explicitly cancels or asks to close the editor, call:

```json
{ "sessionId": "<the-id-from-start>" }
```

with `html_report_close_ui`. This stops the UI but keeps the report session
data for later use.

### 2.1. Visible per-card progress

`html_report_next`, `html_report_submit_writer`, and `html_report_status`
return a `progress` object with `total`, `completed`, `active`, and `next`.
`active` and `next` carry `{ number, id, title }`; use the returned `title`
verbatim. It is the original `result.json` value (`card.title || card.id`),
not a title to rewrite.

Before every `html_report_next` that will fetch card data, send a visible
progress narration first:

- For the first card, send exactly: `正在校验配置，并读取第一张卡片的数据。`
- For a later card, take `progress.next` from the previous successful tool
  response and send exactly: `正在取数 · 第 <number>/<total> 张：<title>。`

After every successful `html_report_submit_writer`, take `progress.active`
and send exactly: `已完成第 <number>/<total> 张：<title>。`

On session recovery, call `html_report_status` first. If `progress.next` is
present, use it to restore the corresponding pre-fetch narration before the
next card fetch. If `html_report_next` or `html_report_submit_writer` returns
an error, tell the user the error and stop; never send a completion narration
for that failed call.

### 3. Write caption

Based on the evidence views returned by `html_report_next`:

- Write 1–3 short paragraphs answering: who is high, who is low, what stands out.
- Every number must come from the evidence views — do not invent, estimate, or infer.
- `pointers` are optional. Prefer one path per **view you used**, such as `/views/<viewId>`.
- Row-level paths like `/views/<viewId>/rows/0/metricValue` are allowed; the kernel folds them to that view. Do **not** submit one pointer per cited number.

Then call `html_report_submit_writer`:

```json
{
  "sessionId": "<id>",
  "cardId": "<from-next>",
  "paragraphs": ["..."],
  "pointers": ["/views/<viewId>"]
}
```

### 4. Repeat

Call `html_report_next` again to fetch the next card (or finish if all cards
are done). When all cards have captions, `html_report_next` composes
`analysis/main.md` and returns `stage: "b2_main"` with the path to
`analysis/main.md` and `html: "awaiting_confirmation"`.

### 5. Optional HTML

After `html_report_next` returns `stage: "b2_main"`, ask the user exactly:

> 初版 `analysis/main.md` 已生成。是否生成同级 `analysis/main.html`？

- If the user **explicitly agrees** (e.g. 生成 HTML / 要 / 是), call only:

```json
html_report_generate_html({ "sessionId": "<id>" })
```

- If the user declines or says 继续 / 暂不生成 HTML, **do not** call the tool.
- If export fails, tell the user the error. They may ask to retry; then call
  `html_report_generate_html` again. Do not retry on your own.
- This HTML is **not** P5 Designer HTML. Never write HTML yourself, never call
  `md2html` or a shell, and never pass output paths or md2html options.

## Rules

- **Never** write `entry.json`, `entry.meta.json`, `caption.md`, `main.md`, or `main.html` yourself.
- **Never** call `qdm-metric-cli` or `md2html` directly — all data and HTML export come through the MCP tools.
- **Never** invent numbers. Every value must trace to an evidence view.
- **Never** skip the user's **继续** reply after A_CONFIG.
- **Never** call `html_report_generate_html` unless the user explicitly asked to generate HTML.
- If `html_report_next` or `html_report_submit_writer` returns an error, tell the
  user the error message and stop. Do not retry without user direction.
- If the user asks about the full pipeline (B3/B4/B5, Designer HTML), explain that
  the first version stops at `analysis/main.md`, with optional sibling `main.html`.

## Reference

- Full pipeline design: `docs/html-report-pipeline.md`
- Quality rubric: `docs/html-report-quality-rubric.md`
- Runtime prerequisite: Harness Data installer (`npx @lumi-ai-lab/harness-data install`) must have initialized `qdm-metric-cli`, config, and authz.
