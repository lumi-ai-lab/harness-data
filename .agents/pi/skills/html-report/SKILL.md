---
name: html-report
description: Generate a responsive standalone HTML report from Markdown when the user asks for a single-file HTML export.
---

# HTML Report

1. Prepare the final report content as UTF-8 Markdown. Keep all business values in the Markdown source.
2. Render one self-contained HTML file:

   ```bash
   node .agents/pi/skills/html-report/scripts/render-report.mjs \
     --md <report.md> \
     --out <report.html>
   ```

3. Return the generated HTML path. Completion requires the command to exit successfully and the output to contain no external stylesheet or script dependency.

