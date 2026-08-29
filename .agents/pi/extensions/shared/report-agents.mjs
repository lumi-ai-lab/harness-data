export const REPORT_AGENT_PACKAGE = "harness-data";

export const REPORT_AGENT_ROLES = Object.freeze([
  "report-writer",
  "report-researcher",
  "report-reviewer",
  "report-designer",
]);

/** @typedef {(typeof REPORT_AGENT_ROLES)[number]} ReportAgentRole */

const observedDispatchNames = {
  "report-writer": "",
  "report-researcher": "",
  "report-reviewer": "",
  "report-designer": "",
};

export function canonicalReportAgentName(role) {
  return `${REPORT_AGENT_PACKAGE}.${role}`;
}

export function reportAgentAliases(role) {
  return [canonicalReportAgentName(role), role];
}

export function reportAgentRoleFromName(name) {
  const raw = String(name || "").trim();
  if (REPORT_AGENT_ROLES.includes(raw)) return raw;
  const prefix = `${REPORT_AGENT_PACKAGE}.`;
  if (raw.startsWith(prefix)) {
    const role = raw.slice(prefix.length);
    if (REPORT_AGENT_ROLES.includes(role)) return role;
  }
  return "";
}

export function isReportAgentName(name, role) {
  const parsed = reportAgentRoleFromName(name);
  return role ? parsed === role : Boolean(parsed);
}

export function runtimeListHasReportAgent(text, role) {
  return reportAgentAliases(role).some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\n)\\s*-\\s*${escaped}(?:\\s|\\()`, "m").test(String(text || ""));
  });
}

export function rememberObservedReportAgents(names) {
  for (const role of REPORT_AGENT_ROLES) {
    const aliases = names.filter((name) => reportAgentRoleFromName(name) === role);
    if (aliases.includes(role)) observedDispatchNames[role] = role;
    else if (aliases.includes(canonicalReportAgentName(role))) {
      observedDispatchNames[role] = canonicalReportAgentName(role);
    }
  }
}

export function rememberObservedReportAgentsFromListText(text) {
  resetObservedReportAgents();
  const names = [];
  for (const role of REPORT_AGENT_ROLES) {
    for (const alias of reportAgentAliases(role)) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:^|\\n)\\s*-\\s*${escaped}(?:\\s|\\()`, "m").test(String(text || ""))) {
        names.push(alias);
      }
    }
  }
  rememberObservedReportAgents(names);
}

export function reportAgentDispatchName(role) {
  const observed = observedDispatchNames[role];
  if (!observed) return role;
  if (observed === role) return role;
  return observed;
}

export function resetObservedReportAgents() {
  for (const role of REPORT_AGENT_ROLES) observedDispatchNames[role] = "";
}
