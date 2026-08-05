/**
 * Force --data-auth/--auth-blob only for real shell invocations of:
 *   qdm-metric-cli analysis execute ...
 *
 * Mentions inside quotes, heredocs, or commit messages must NOT be rewritten.
 * Detection: mask quoted/heredoc regions, then match command-word invocation.
 */

/** Binary token that can start a real metric-cli analysis execute. */
const METRIC_BIN_SRC =
  String.raw`(?:\$\{?QDM_METRIC_CLI\}?|(?:\./)?(?:bin/)?qdm-metric-cli|/(?:[^\s;|&'"]+/)*qdm-metric-cli)`;

/**
 * Replace contents of quotes and heredoc bodies with spaces (newlines kept).
 * Keeps `"$QDM_METRIC_CLI"` / `"${QDM_METRIC_CLI}"` unmasked so real env invocations still match.
 *
 * @param {string} command
 */
export function maskQuotedAndHeredocRegions(command) {
  if (typeof command !== "string" || !command) return "";
  const chars = command.split("");
  const n = chars.length;
  let i = 0;

  const spaceOut = (from, to) => {
    for (let k = from; k < to && k < n; k++) {
      if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " ";
    }
  };

  const isProtectedVarQuote = (inner) =>
    /^\$\{?QDM_METRIC_CLI\}?$/.test(inner.trim());

  while (i < n) {
    // Heredoc: <<[-]['|"]TAG['|"]
    if (chars[i] === "<" && chars[i + 1] === "<") {
      let j = i + 2;
      if (chars[j] === "-") j++;
      while (j < n && /\s/.test(chars[j])) j++;
      let quote = "";
      if (chars[j] === "'" || chars[j] === '"') {
        quote = chars[j];
        j++;
      }
      const tagStart = j;
      while (j < n && /[A-Za-z0-9_]/.test(chars[j])) j++;
      if (j > tagStart) {
        const tag = chars.slice(tagStart, j).join("");
        if (quote && chars[j] === quote) j++;
        let bodyStart = j;
        while (bodyStart < n && chars[bodyStart] !== "\n") bodyStart++;
        if (bodyStart < n) bodyStart++;
        let k = bodyStart;
        let closed = false;
        while (k < n) {
          if (k === bodyStart || chars[k - 1] === "\n") {
            let t = k;
            while (t < n && chars[t] === "\t") t++;
            if (chars.slice(t, t + tag.length).join("") === tag) {
              const after = t + tag.length;
              if (after >= n || chars[after] === "\n" || chars[after] === "\r") {
                spaceOut(bodyStart, t);
                i = after;
                closed = true;
                break;
              }
            }
          }
          k++;
        }
        if (closed) continue;
        spaceOut(bodyStart, n);
        break;
      }
    }

    if (chars[i] === "'") {
      let j = i + 1;
      while (j < n && chars[j] !== "'") j++;
      if (j < n) {
        const inner = chars.slice(i + 1, j).join("");
        if (!isProtectedVarQuote(inner)) spaceOut(i + 1, j);
        i = j + 1;
        continue;
      }
      spaceOut(i + 1, n);
      break;
    }

    if (chars[i] === "$" && chars[i + 1] === "'") {
      let j = i + 2;
      while (j < n) {
        if (chars[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (chars[j] === "'") break;
        j++;
      }
      if (j < n) {
        spaceOut(i + 2, j);
        i = j + 1;
        continue;
      }
      spaceOut(i + 2, n);
      break;
    }

    if (chars[i] === '"') {
      let j = i + 1;
      while (j < n) {
        if (chars[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (chars[j] === '"') break;
        j++;
      }
      if (j < n) {
        const inner = chars.slice(i + 1, j).join("");
        // Keep "$QDM_METRIC_CLI" so real invocations remain visible on skeleton.
        if (!isProtectedVarQuote(inner)) spaceOut(i + 1, j);
        i = j + 1;
        continue;
      }
      spaceOut(i + 1, n);
      break;
    }

    i++;
  }

  return chars.join("");
}

/**
 * True only when the shell command actually *invokes*
 * qdm-metric-cli (or $QDM_METRIC_CLI) with subcommand `analysis execute`.
 *
 * @param {string} command
 */
export function isMetricAnalysisExecute(command) {
  if (typeof command !== "string" || !command.trim()) return false;

  const skeleton = maskQuotedAndHeredocRegions(command);

  // Command-word metric-cli at start of a pipeline/list segment + analysis execute.
  // Optional quotes around $QDM_METRIC_CLI remain after protected-var mask.
  const invocation = new RegExp(
    String.raw`(?:^|[\n;|&]|(?:\b(?:then|do|if|elif|else)\b))\s*` +
      String.raw`(?:(?:source|\.)\s+[^\s;|&]+\s*(?:&&\s*)?)*` +
      String.raw`(?:[A-Za-z_][\w]*=(?:'[^\n']*'|"[^\n"]*"|\S+)\s+)*` +
      String.raw`(?:'|")?` +
      METRIC_BIN_SRC +
      String.raw`(?:'|")?` +
      String.raw`\s+analysis\s+execute\b`,
  );

  return invocation.test(skeleton);
}

/**
 * Rewrite command-word metric-cli tokens that start an `analysis execute` invocation.
 *
 * @param {string} command
 * @param {string} metricCliPath absolute path to qdm-metric-cli
 */
export function rewriteMetricCliInvocation(command, metricCliPath) {
  if (!metricCliPath || typeof command !== "string") return command;
  const quoted = shellQuote(metricCliPath);
  const skeleton = maskQuotedAndHeredocRegions(command);

  const binRe = new RegExp(String.raw`(?:'|")?` + METRIC_BIN_SRC + String.raw`(?:'|")?`, "g");

  let out = "";
  let last = 0;
  let match;
  while ((match = binRe.exec(skeleton)) !== null) {
    const binStart = match.index;
    const binEnd = binStart + match[0].length;
    const invokeHere = new RegExp(
      String.raw`^(?:'|")?` + METRIC_BIN_SRC + String.raw`(?:'|")?\s+analysis\s+execute\b`,
    ).test(skeleton.slice(binStart));
    if (!invokeHere) continue;
    out += command.slice(last, binStart) + quoted;
    last = binEnd;
  }
  out += command.slice(last);
  return out;
}

/**
 * Strip model-supplied auth flags (used only after isMetricAnalysisExecute gate).
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
 *
 * @param {string} command
 * @param {string} flags
 */
export function insertFlagsBeforeShellTail(command, flags) {
  const skeleton = maskQuotedAndHeredocRegions(command);
  const inv = new RegExp(
    String.raw`(?:'|")?` + METRIC_BIN_SRC + String.raw`(?:'|")?\s+analysis\s+execute\b`,
    "i",
  ).exec(skeleton);

  let fromExecute;
  if (inv) {
    const rel = inv[0].toLowerCase().lastIndexOf("execute");
    fromExecute = inv.index + rel;
  } else {
    const m = command.match(/\bexecute\b/i);
    if (!m || m.index == null) return `${command}${flags}`;
    fromExecute = m.index;
  }

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
  // Gate: only real metric-cli analysis execute invocations (not prose / commit messages).
  if (typeof command !== "string" || !isMetricAnalysisExecute(command)) {
    return undefined;
  }

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
