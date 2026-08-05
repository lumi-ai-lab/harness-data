/**
 * Force auth flags only for real shell invocations of:
 *   qdm-metric-cli analysis execute ...  → --data-auth --auth-blob
 *   qdm-metric-cli auth describe ...     → --auth-blob
 *
 * Mentions inside quotes, heredocs, or commit messages must NOT be rewritten.
 * Detection: mask quoted/heredoc regions, then match command-word invocation.
 */

/** Binary token that can start a real metric-cli invocation. */
const METRIC_BIN_SRC =
  String.raw`(?:\$\{?QDM_METRIC_CLI\}?|(?:\./)?(?:bin/)?qdm-metric-cli|/(?:[^\s;|&'"]+/)*qdm-metric-cli)`;

/** Subcommand patterns gated by authz (command-word form only). */
const SUBCMD_ANALYSIS_EXECUTE = String.raw`analysis\s+execute`;
const SUBCMD_AUTH_DESCRIBE = String.raw`auth\s+describe`;
const SUBCMD_AUTHZ_GATED = String.raw`(?:analysis\s+execute|auth\s+describe)`;

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
 * @param {string} subcmdPattern e.g. analysis\\s+execute
 */
function metricInvocationRegex(subcmdPattern) {
  return new RegExp(
    String.raw`(?:^|[\n;|&]|(?:\b(?:then|do|if|elif|else)\b))\s*` +
      String.raw`(?:(?:source|\.)\s+[^\s;|&]+\s*(?:&&\s*)?)*` +
      String.raw`(?:[A-Za-z_][\w]*=(?:'[^\n']*'|"[^\n"]*"|\S+)\s+)*` +
      String.raw`(?:'|")?` +
      METRIC_BIN_SRC +
      String.raw`(?:'|")?` +
      String.raw`\s+` +
      subcmdPattern +
      String.raw`\b`,
  );
}

/**
 * @param {string} command
 * @param {string} subcmdPattern
 */
function matchesMetricInvocation(command, subcmdPattern) {
  if (typeof command !== "string" || !command.trim()) return false;
  const skeleton = maskQuotedAndHeredocRegions(command);
  return metricInvocationRegex(subcmdPattern).test(skeleton);
}

/**
 * True only when the shell command actually *invokes*
 * qdm-metric-cli (or $QDM_METRIC_CLI) with subcommand `analysis execute`.
 *
 * @param {string} command
 */
export function isMetricAnalysisExecute(command) {
  return matchesMetricInvocation(command, SUBCMD_ANALYSIS_EXECUTE);
}

/**
 * True only when the shell command actually *invokes*
 * qdm-metric-cli with subcommand `auth describe`.
 *
 * @param {string} command
 */
export function isMetricAuthDescribe(command) {
  return matchesMetricInvocation(command, SUBCMD_AUTH_DESCRIBE);
}

/**
 * True when the command is gated by authz injection (execute or describe).
 *
 * @param {string} command
 */
export function isMetricAuthzGatedCommand(command) {
  return isMetricAnalysisExecute(command) || isMetricAuthDescribe(command);
}

/**
 * Rewrite command-word metric-cli tokens that start a gated invocation
 * (`analysis execute` or `auth describe`).
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
      String.raw`^(?:'|")?` +
        METRIC_BIN_SRC +
        String.raw`(?:'|")?\s+` +
        SUBCMD_AUTHZ_GATED +
        String.raw`\b`,
    ).test(skeleton.slice(binStart));
    if (!invokeHere) continue;
    out += command.slice(last, binStart) + quoted;
    last = binEnd;
  }
  out += command.slice(last);
  return out;
}

/**
 * Strip model-supplied auth flags (used only after gated-command gate).
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
 * Insert flags into the metric-cli argv, not after shell pipes/redirections.
 * Anchors after the subcommand keyword (execute | describe).
 *
 * @param {string} command
 * @param {string} flags
 * @param {"execute" | "describe"} [anchorWord="execute"]
 */
export function insertFlagsBeforeShellTail(command, flags, anchorWord = "execute") {
  const skeleton = maskQuotedAndHeredocRegions(command);
  const subcmd =
    anchorWord === "describe" ? SUBCMD_AUTH_DESCRIBE : SUBCMD_ANALYSIS_EXECUTE;
  const inv = new RegExp(
    String.raw`(?:'|")?` + METRIC_BIN_SRC + String.raw`(?:'|")?\s+` + subcmd + String.raw`\b`,
    "i",
  ).exec(skeleton);

  let fromAnchor;
  if (inv) {
    const lower = inv[0].toLowerCase();
    const rel = lower.lastIndexOf(anchorWord);
    fromAnchor = inv.index + (rel >= 0 ? rel : inv[0].length - anchorWord.length);
  } else {
    const m = command.match(new RegExp(String.raw`\b${anchorWord}\b`, "i"));
    if (!m || m.index == null) return `${command}${flags}`;
    fromAnchor = m.index;
  }

  const tail = command.slice(fromAnchor);
  const op = tail.match(/\s(?:\||&&|;|2?>|1?>|&>)/);
  if (!op || op.index == null) {
    return `${command}${flags}`;
  }
  const abs = fromAnchor + op.index;
  return `${command.slice(0, abs)}${flags}${command.slice(abs)}`;
}

/**
 * Inject --data-auth --auth-blob for analysis execute.
 *
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
  return insertFlagsBeforeShellTail(cleaned, flags, "execute");
}

/**
 * Inject --auth-blob for auth describe (no --data-auth).
 *
 * @param {string} command
 * @param {string} blob encrypted qdm1enc blob
 * @param {string} [metricCliPath]
 */
export function injectAuthDescribeBlob(command, blob, metricCliPath = "") {
  let cleaned = stripAuthFlags(command);
  if (metricCliPath) {
    cleaned = rewriteMetricCliInvocation(cleaned, metricCliPath);
  }
  const flags = ` --auth-blob ${shellQuote(blob)}`;
  return insertFlagsBeforeShellTail(cleaned, flags, "describe");
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
  // Gate: only real metric-cli gated invocations (not prose / commit messages).
  if (typeof command !== "string" || !isMetricAuthzGatedCommand(command)) {
    return undefined;
  }

  const isDescribe = isMetricAuthDescribe(command);

  if (options.mode !== "on") {
    if (options.metricCliPath && event.input && typeof event.input === "object") {
      event.input.command = rewriteMetricCliInvocation(command, options.metricCliPath);
    }
    return undefined;
  }

  if (!options.blob) {
    const defaultReason = isDescribe
      ? "authz mode is on but no encrypted auth blob is bound for this turn; cannot run qdm-metric-cli auth describe"
      : "authz mode is on but no encrypted auth blob is bound for this turn; cannot run qdm-metric-cli analysis execute";
    return {
      block: true,
      reason: options.missingReason || defaultReason,
    };
  }

  if (!event.input || typeof event.input !== "object") {
    return { block: true, reason: "authz: invalid tool input" };
  }

  if (isDescribe) {
    event.input.command = injectAuthDescribeBlob(
      command,
      options.blob,
      options.metricCliPath || "",
    );
  } else {
    event.input.command = injectDataAuth(command, options.blob, options.metricCliPath || "");
  }
  return undefined;
}
