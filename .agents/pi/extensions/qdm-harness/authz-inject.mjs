/**
 * Detect qdm-metric-cli analysis execute and force --data-auth --auth-blob.
 * Also rewrites bare/env metric-cli invocations to the configured absolute path.
 */

/**
 * @param {string} command
 */
export function isMetricAnalysisExecute(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  // Match binary name, env var expansion, or path ending with qdm-metric-cli.
  const invokesMetric =
    /\bqdm-metric-cli\b/.test(command) ||
    /\$\{?QDM_METRIC_CLI\}?/.test(command) ||
    /\/qdm-metric-cli\b/.test(command);
  if (!invokesMetric) return false;
  return /\banalysis\b/.test(command) && /\bexecute\b/.test(command);
}

/**
 * Prefer absolute configured path so Agent need not manage PATH/env each turn.
 * @param {string} command
 * @param {string} metricCliPath absolute path to qdm-metric-cli
 */
export function rewriteMetricCliInvocation(command, metricCliPath) {
  if (!metricCliPath || typeof command !== "string") return command;
  const quoted = shellQuote(metricCliPath);
  let out = command;
  // "$QDM_METRIC_CLI" / ${QDM_METRIC_CLI} / $QDM_METRIC_CLI
  out = out.replace(/(["']?)\$\{?QDM_METRIC_CLI\}?\1/g, quoted);
  // bare or relative binary name (not already an absolute path containing the name only as suffix handled below)
  out = out.replace(/(^|[\s;|&])(?:\.\/)?(?:bin\/)?qdm-metric-cli\b/g, `$1${quoted}`);
  return out;
}

/**
 * Strip model-supplied auth flags so they cannot override the host/dev blob.
 * @param {string} command
 */
export function stripAuthFlags(command) {
  let out = command;
  out = out.replace(/(^|\s)--data-auth\b/g, " ");
  out = out.replace(
    /(^|\s)--auth-blob(?:\s*=\s*|\s+)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)/g,
    " ",
  );
  out = out.replace(
    /(^|\s)--auth-json(?:\s*=\s*|\s+)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)/g,
    " ",
  );
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * @param {string} value
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Insert auth flags into the metric-cli argv, not after shell pipes/redirections.
 * Example:
 *   ... analysis execute --metric x | python
 * becomes
 *   ... analysis execute --metric x --data-auth --auth-blob '...' | python
 *
 * @param {string} command
 * @param {string} flags  already-quoted flag fragment, e.g. " --data-auth --auth-blob 'x'"
 */
export function insertFlagsBeforeShellTail(command, flags) {
  const executeMatch = command.match(/\bexecute\b/i);
  if (!executeMatch || executeMatch.index == null) {
    return `${command}${flags}`;
  }
  const fromExecute = executeMatch.index;
  // Earliest shell operator after `execute` that leaves the metric-cli argv.
  const tail = command.slice(fromExecute);
  const op = tail.match(/\s(?:\||&&|;|2?>|1?>|&>)/);
  if (!op || op.index == null) {
    return `${command}${flags}`;
  }
  const abs = fromExecute + op.index;
  return `${command.slice(0, abs)}${flags}${command.slice(abs)}`;
}

/**
 * @param {string} command
 * @param {string} blob encrypted qdm1enc blob
 * @param {string} [metricCliPath]
 */
export function injectDataAuth(command, blob, metricCliPath = "") {
  let cleaned = stripAuthFlags(command);
  if (metricCliPath) {
    cleaned = rewriteMetricCliInvocation(cleaned, metricCliPath);
  }
  const flags = ` --data-auth --auth-blob ${shellQuote(blob)}`;
  return insertFlagsBeforeShellTail(cleaned, flags);
}

/**
 * Apply authz policy to a bash tool_call event.
 *
 * @param {{
 *   toolName?: string,
 *   input?: { command?: string },
 * }} event
 * @param {{
 *   mode: "off" | "on",
 *   blob: string | null,
 *   metricCliPath?: string,
 *   missingReason?: string,
 * }} options
 * @returns {{ block?: boolean, reason?: string } | undefined}
 */
export function applyAuthzToToolCall(event, options) {
  if (!["bash", "Bash"].includes(event.toolName ?? "")) return undefined;
  const command = event.input?.command;
  if (typeof command !== "string" || !isMetricAnalysisExecute(command)) {
    return undefined;
  }

  // Even when authz is off, rewrite bare metric-cli to configured absolute path.
  if (options.mode !== "on") {
    if (options.metricCliPath && event.input && typeof event.input === "object") {
      event.input.command = rewriteMetricCliInvocation(command, options.metricCliPath);
    }
    return undefined;
  }

  if (!options.blob) {
    return {
      block: true,
      reason:
        options.missingReason ||
        "authz mode is on but no encrypted auth blob is bound for this turn; cannot run qdm-metric-cli analysis execute",
    };
  }

  if (!event.input || typeof event.input !== "object") {
    return { block: true, reason: "authz: invalid tool input" };
  }

  event.input.command = injectDataAuth(command, options.blob, options.metricCliPath || "");
  return undefined;
}
