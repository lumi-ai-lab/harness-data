---
name: html-report-design
description: Design and visually verify the final responsive single-file HTML for the QDM html-report pipeline while preserving its frozen compiled business content exactly.
---

# HTML Report Design

Own the presentation layer of a passed, frozen analytical report. Make a real
frontend design decision for each report; do not act as a command runner and do
not edit business content.

## Inputs and boundary

Read only the assigned `$SESSION/report/` bundle:

- `design-input.json`: title, outline, hashes, markers, viewports.
- `report.content.html`: immutable semantic report body.
- `report.md`: read only when hierarchy needs clarification.
- `render-manifest.json`: coverage metadata, not design copy.

Do not read Harness Wiki, playbooks, raw `data/**`, project source, or unrelated
session files. Never change Markdown, values, rows, headings, or compiled
content. You may write only under `$SESSION/report/`.

Read [references/report-design-system.md](references/report-design-system.md)
before designing. Start from [assets/report-shell-starter.html](assets/report-shell-starter.html),
then materially adapt its structure and CSS to the actual report outline.

## One-run workflow

Complete the whole workflow in one SubAgent run. Do not ask the Report Editor
for intermediate approval.

1. Run `compile-report-content.mjs` for the assigned result. It verifies that
   `report.md`, `render-manifest.json`, full-table markers, and their hashes are
   one current immutable bundle; never repair a binding failure by hand.
2. Inspect only the exact `design-input.json`, immutable content, design
   reference, and starter paths injected by the parent. Do not re-read this
   `SKILL.md`, discover directories, or inspect workflow script source.
3. Write `$SESSION/report/report.design.html` once with exactly one literal
   `<!-- HTML_REPORT_CONTENT -->` slot. `report.content.html` is read only to
   understand hierarchy and class names; never copy any of it into the shell.
4. Immediately run `compose-report.mjs`. It is the only content inserter; do
   not edit or rewrite the shell before this first compose.
5. Run `capture-report.mjs` for desktop and mobile screenshots.
6. Inspect both screenshots. Only after both have been read may a visible defect
   trigger an edit; repeat compose/capture when needed, with at most two internal
   repair rounds. Never replace or edit the content slot itself.
7. Write `design-result.draft.json`, then run `finalize-design.mjs`.
8. Run `check-session-layout.mjs --phase html` once and call
   `structured_output` once with the fixed parent-owned schema. After layout
   succeeds, do not re-read final HTML/meta/result artifacts or return a
   generic acceptance report.

Commands are defined in the Report Designer role file. Use them exactly; never
use `render-report.mjs` on the normal path.

## Design ownership

You decide:

- information hierarchy and report shell;
- typography, spacing, color, section rhythm, navigation and responsive rules;
- table density, sticky headers/columns where useful, and mobile overflow;
- restrained interaction such as a compact section navigator;
- print behavior and accessibility details.

Do not create new analytical charts or KPI values from report numbers. Visual
emphasis may reveal existing conclusions but may not rewrite them.

## Acceptance

Both screenshots must pass before finalization:

- no overlap, clipping, unreadable text, blank content, or page-wide overflow;
- title and report identity are clear in the first viewport;
- long tables remain complete and usable;
- desktop is not a stretched mobile page; mobile is not a centered desktop card;
- colors, spacing, hierarchy, and density fit a serious operational report;
- print CSS preserves content and table readability.

Write this draft before finalization:

```json
{
  "status": "pass",
  "viewports": {
    "desktop": { "pass": true, "notes": "..." },
    "mobile": { "pass": true, "notes": "..." }
  },
  "notes": []
}
```

`finalize-design.mjs` accepts only the current Session draft and binds it to the
fixed HTML plus exactly two real PNG screenshots at the required viewport widths
and minimum viewport heights.
