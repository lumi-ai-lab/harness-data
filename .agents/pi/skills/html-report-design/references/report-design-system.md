# QDM Analytical Report Design System

This reference adapts the reusable visual discipline from the QDM Assistant
mobile design system to responsive analytical documents. It deliberately does
not inherit mobile App page families, 375pt layout rules, status bars, bottom
tabs, or product/order/profile templates.

## Product character

- Operational, credible, and easy to scan repeatedly.
- Dense enough for evidence review without looking compressed.
- Answer-first: conclusions before supporting detail, full evidence last.
- Restrained decoration; visual emphasis must express information hierarchy.

## Tokens

Use these as a starting system, not a mandate to make the page one-note blue.

| Role | Value | Use |
| --- | --- | --- |
| Brand primary | `#4f86ff` | navigation, active state, limited emphasis |
| Brand deep | `#2457c5` | strong headings and accessible text accents |
| Page | `#f4f7fb` | outer page background |
| Surface | `#ffffff` | report surface and table background |
| Text | `#222222` | titles and primary body |
| Secondary | `#666666` | metadata and supporting text |
| Divider | `#e5e9f0` | rules and table grid |
| Success | `#0d8f58` | verified/pass state only |
| Warning | `#d97706` | cautions and exceptional values |
| Error | `#d14343` | hard issues only |

Use neutral surfaces with at least one semantic accent beyond the brand family.
Do not use gradients, glassmorphism, decorative blobs, or heavy shadows.

## Typography and spacing

- Font stack: `PingFang SC`, `Microsoft YaHei`, `Noto Sans CJK SC`, system UI.
- Use fixed, deliberate sizes; never scale text with viewport width.
- Body: 15-16px desktop, 14-15px mobile, line-height 1.65-1.75.
- Report title: 28-34px desktop, 23-28px mobile.
- Section headings: 18-22px. Compact panel headings: 15-17px.
- Letter spacing is `0`.
- Use a 4px base with 8/12/16/24/32px primary intervals.

## Structure

- Treat the report as a document, not a marketing landing page or dashboard.
- Avoid cards around every section and never nest cards.
- A compact header may contain title, quality state, session and generation time.
- A desktop section navigator is useful for reports with three or more H2s.
- Keep the main reading measure around 900-1100px, but let wide evidence tables
  use more horizontal space when available.
- Preserve a visible path from conclusion to evidence.

## Tables

- Full rows are mandatory; do not hide, paginate, truncate, or replace tables.
- Use horizontal scrolling on narrow viewports, with a visible scroll affordance.
- Align numeric cells right when reliably detectable; keep dimensions left.
- Use tabular numerals, compact row heights, and a high-contrast sticky header.
- Zebra striping should be subtle. Hover may assist desktop scanning.
- Do not color every cell. Reserve semantic emphasis for content already marked.

## Responsive and print

- Desktop target: 1440x1000. Mobile target: 390x844.
- On mobile, remove side navigation from layout or convert it to a compact top
  control; do not preserve a desktop sidebar that squeezes the report.
- No page-wide horizontal overflow. Table wrappers may scroll independently.
- Avoid fixed heights for narrative sections.
- Print removes navigation and screen-only chrome, uses a white background, and
  repeats table headers where supported.

## Visual QA

Inspect the screenshots, not only the source:

- first viewport hierarchy;
- longest heading and longest table cell;
- wide table containment and complete marker-backed table presence;
- mobile wrapping and touch target sizing;
- section spacing, color balance, contrast, and footer position;
- no blank or accidentally hidden content.

