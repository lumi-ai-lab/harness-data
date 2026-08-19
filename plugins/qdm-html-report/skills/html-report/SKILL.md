---
name: html-report
description: Open qdm-metric-cli ui for the user to save result.json, then generate analysis/main.md (first version, stops at B2_MAIN).
---

# HTML Report (Codex CLI / ChatGPT App)

This skill drives the html-report pipeline through a local MCP server.
It works on **both Codex CLI and ChatGPT Desktop App** — no `codex` binary
required on the production path.

The MCP server exposes four tools. Call them in order:

```
html_report_start    → create session, open qdm-metric-cli ui
html_report_next     → advance pipeline (B0 preflight → B2 per-card fetch)
html_report_submit_writer → submit caption for the current card
html_report_status   → query current state
```

## Pipeline (first version)

```
A_CONFIG        user builds cards in qdm-metric-cli ui → saves result.json
  ↓ user replies "继续"
B0_PREFLIGHT    validate result.json + metric CLI (no PI Agent check)
  ↓ auto-advance on pass
B2_WRITER       per card: fetch-entry → prepare evidence → host writes caption
  ↓ submit_writer per card
B2_MAIN         compose-main.mjs → analysis/main.md (STOP)
```

Stops at `B2_MAIN`. No B25/B3/B4/B5, no HTML, no Designer.

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

The server validates `result.json` (B0), then fetches the first card's data
and returns compact evidence views. You must now write a short caption.

### 3. Write caption

Based on the evidence views returned by `html_report_next`:

- Write 1–3 short paragraphs answering: who is high, who is low, what stands out.
- Every number must come from the evidence views — do not invent, estimate, or infer.
- Include `pointers` — JSON pointers like `/views/<viewId>/rows/0/value` — for each number you cite.

Then call `html_report_submit_writer`:

```json
{
  "sessionId": "<id>",
  "cardId": "<from-next>",
  "paragraphs": ["..."],
  "pointers": ["/views/.../rows/0/value"]
}
```

### 4. Repeat

Call `html_report_next` again to fetch the next card (or finish if all cards
are done). When all cards have captions, `html_report_next` calls
`compose-main.mjs` and returns `stage: "b2_main"` with the path to
`analysis/main.md`. The pipeline stops there.

## Rules

- **Never** write `entry.json`, `entry.meta.json`, `caption.md`, or `main.md` yourself.
- **Never** call `qdm-metric-cli` directly — all data comes through the MCP tools.
- **Never** invent numbers. Every value must trace to an evidence view.
- **Never** skip the user's **继续** reply after A_CONFIG.
- If `html_report_next` or `html_report_submit_writer` returns an error, tell the
  user the error message and stop. Do not retry without user direction.
- If the user asks about the full pipeline (B3/B4/B5, HTML), explain that the
  first version stops at `analysis/main.md`.

## Reference

- Full pipeline design: `docs/html-report-pipeline.md`
- Quality rubric: `docs/html-report-quality-rubric.md`
- PI version (full pipeline): `.agents/pi/skills/html-report/SKILL.md`
