#!/usr/bin/env node
/**
 * Repo-side preflight: verify all four html-report Pi agents are registered.
 * Does NOT replace runtime subagent({ action: "list" }).
 *
 * Usage:
 *   node check-report-agents.mjs
 *   node check-report-agents.mjs --only report-writer
 */
import { readFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);
const REQUIRED = [
  "report-writer",
  "report-researcher",
  "report-reviewer",
  "report-designer",
];

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const names = only ? [only] : REQUIRED;

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function checkOne(name) {
  const agentPath = join(root, ".pi", "agents", `${name}.md`);
  const rolePath = join(root, ".agents", "pi", "skills", "html-report", "agents", `${name}.md`);
  const item = {
    name,
    ok: true,
    agentPath,
    rolePath,
    agentFileExists: false,
    roleFileExists: false,
    frontmatterName: null,
    messages: [],
  };
  item.agentFileExists = await exists(agentPath);
  item.roleFileExists = await exists(rolePath);
  if (!item.agentFileExists) {
    item.ok = false;
    item.messages.push(`missing registration: ${agentPath}`);
  } else {
    const text = await readFile(agentPath, "utf8");
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
    if (!m) {
      item.ok = false;
      item.messages.push("missing YAML frontmatter");
    } else {
      const frontmatter = Object.fromEntries(
        m[1]
          .split("\n")
          .map((line) => line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/))
          .filter(Boolean)
          .map((match) => [match[1], match[2].trim()])
      );
      const nameLine = m[1].split("\n").find((l) => /^name:\s*/.test(l));
      const n = nameLine ? nameLine.replace(/^name:\s*/, "").trim() : null;
      item.frontmatterName = n;
      if (n !== name) {
        item.ok = false;
        item.messages.push(`frontmatter name must be "${name}", got ${JSON.stringify(n)}`);
      }
      if (name === "report-writer") {
        const tools = String(frontmatter.tools || "")
          .split(",")
          .map((tool) => tool.trim())
          .filter(Boolean);
        const expectedTools = ["ack_cli_data", "submit_card_caption"];
        if (
          tools.length !== expectedTools.length ||
          expectedTools.some((tool) => !tools.includes(tool))
        ) {
          item.ok = false;
          item.messages.push("report-writer tools must be exactly ack_cli_data, submit_card_caption (no read, bash, or mutating tools)");
        }
        const fetchExtension = ".agents/pi/extensions/report-writer-fetch/index.mjs";
        if (frontmatter.subagentOnlyExtensions !== fetchExtension) {
          item.ok = false;
          item.messages.push(`report-writer must load its child-only fetch tool from ${fetchExtension}`);
        } else if (!(await exists(join(root, fetchExtension)))) {
          item.ok = false;
          item.messages.push(`missing report-writer fetch extension: ${join(root, fetchExtension)}`);
        }
        if (frontmatter.extensions !== "") {
          item.ok = false;
          item.messages.push("report-writer must disable project-wide child extensions so recall hooks cannot run");
        }
        if (frontmatter.inheritProjectContext !== "false") {
          item.ok = false;
          item.messages.push("report-writer must not inherit unrelated project context");
        }
        if (frontmatter.completionGuard !== "false") {
          item.ok = false;
          item.messages.push("report-writer completionGuard must be false for its structured-return task");
        }
        if (frontmatter.acceptanceRole !== "read-only") {
          item.ok = false;
          item.messages.push("report-writer acceptanceRole must be read-only");
        }
        try {
          const acceptance = JSON.parse(frontmatter.acceptance || "null");
          if (acceptance?.level !== "none") {
            item.ok = false;
            item.messages.push("report-writer acceptance must disable implementation evidence requirements");
          }
        } catch {
          item.ok = false;
          item.messages.push("report-writer acceptance must be valid JSON frontmatter");
        }
      }
      if (name === "report-researcher") {
        const guardExtension = ".agents/pi/extensions/report-researcher-guard/index.mjs";
        if (frontmatter.subagentOnlyExtensions !== guardExtension) {
          item.ok = false;
          item.messages.push(`report-researcher must load its child-only guard from ${guardExtension}`);
        } else if (!(await exists(join(root, guardExtension)))) {
          item.ok = false;
          item.messages.push(`missing report-researcher guard extension: ${join(root, guardExtension)}`);
        }
        if (frontmatter.extensions !== "") {
          item.ok = false;
          item.messages.push("report-researcher must disable project-wide child extensions");
        }
      }
      if (name === "report-reviewer") {
        const guardExtension = ".agents/pi/extensions/report-reviewer-guard/index.mjs";
        if (frontmatter.subagentOnlyExtensions !== guardExtension) {
          item.ok = false;
          item.messages.push(`report-reviewer must load its child-only guard from ${guardExtension}`);
        } else if (!(await exists(join(root, guardExtension)))) {
          item.ok = false;
          item.messages.push(`missing report-reviewer guard extension: ${join(root, guardExtension)}`);
        }
        const reviewerTools = String(frontmatter.tools || "")
          .split(",")
          .map((tool) => tool.trim())
          .filter(Boolean);
        if (reviewerTools.join(",") !== "read,submit_review_scorecard") {
          item.ok = false;
          item.messages.push("report-reviewer tools must be exactly read, submit_review_scorecard (parent owns quality-scan and layout)");
        }
        if (frontmatter.extensions !== "") {
          item.ok = false;
          item.messages.push("report-reviewer must disable project-wide child extensions so recall hooks cannot run");
        }
        if (frontmatter.inheritProjectContext !== "false") {
          item.ok = false;
          item.messages.push("report-reviewer must not inherit unrelated project context");
        }
      }
      if (name === "report-designer") {
        const designerTools = String(frontmatter.tools || "")
          .split(",")
          .map((tool) => tool.trim())
          .filter(Boolean);
        if (designerTools.join(",") !== "read,bash,write,edit") {
          item.ok = false;
          item.messages.push("report-designer tools must be exactly read, bash, write, edit (no ls/find/grep exploration tools)");
        }
        const guardExtension = ".agents/pi/extensions/report-designer-guard/index.mjs";
        if (frontmatter.subagentOnlyExtensions !== guardExtension) {
          item.ok = false;
          item.messages.push(`report-designer must load child-only guard ${guardExtension}`);
        }
        if (frontmatter.extensions !== "") {
          item.ok = false;
          item.messages.push("report-designer must disable project-wide child extensions so recall hooks cannot run");
        }
        if (frontmatter.inheritProjectContext !== "false") {
          item.ok = false;
          item.messages.push("report-designer must not inherit unrelated project context");
        }
      }
    }
  }
  if (!item.roleFileExists) {
    item.ok = false;
    item.messages.push(`missing role detail: ${rolePath}`);
  }
  if (item.ok) {
    item.messages.push(`OK. Still verify subagent list includes "${name}" after Pi restart.`);
  }
  return item;
}

const agents = [];
for (const n of names) {
  if (!REQUIRED.includes(n)) {
    console.error(`unknown agent ${n}; allowed: ${REQUIRED.join(", ")}`);
    process.exit(2);
  }
  agents.push(await checkOne(n));
}
const ok = agents.every((a) => a.ok);
const report = {
  ok,
  required: REQUIRED,
  agents,
  messages: ok
    ? ["All checked report-* agents present. Runtime list still required in Pi."]
    : ["Fix missing files, restart Pi from repo root, then subagent({ action: \"list\" })."],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(ok ? 0 : 1);
