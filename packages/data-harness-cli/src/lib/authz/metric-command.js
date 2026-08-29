import { SHELL_BASH, SHELL_CMD, SHELL_POWERSHELL } from "./constants.js";

const WINDOWS = process.platform === "win32";

const windowsMetricBinPattern =
  String.raw`(?:(?:[A-Za-z]:[/\\])|(?:\.\.?[/\\])|/)[^;|&'"\r\n]*[/\\]qdm-metric-cli(?:\.exe)?`;

const metricBinPattern =
  String.raw`(?:\$\{QDM_METRIC_CLI(?::-[^}]*)?\}|\$QDM_METRIC_CLI|[A-Za-z]:[/\\](?:[^\s;|&'"]+[/\\])*qdm-metric-cli(?:\.exe)?|/(?:[^\s;|&'"]+/)*qdm-metric-cli(?:\.exe)?|(?:[^\s;|&'"]+[/\\])*qdm-metric-cli(?:\.exe)?)`;

export function isMetricAnalysisExecute(command) {
  return matchesMetricInvocation(command, String.raw`analysis\s+execute`);
}

export function isMetricAuthDescribe(command) {
  return matchesMetricInvocation(command, String.raw`auth\s+describe`);
}

export function isMetricAuthzGatedCommand(command) {
  return isMetricAnalysisExecute(command) || isMetricAuthDescribe(command);
}

export function metricInvocationCount(command) {
  return metricInvocationRegexp(String.raw`(?:analysis\s+execute|auth\s+describe)`).execAll(
    maskQuotedAndHeredocRegions(command),
  ).length;
}

export function looksLikeGatedMetricCommand(command) {
  const marker = /(?:qdm-metric-cli(?:\.exe)?|%QDM_METRIC_CLI%|\$env:QDM_METRIC_CLI|\$\{?QDM_METRIC_CLI(?:\:-[^}]*)?\}?)/i;
  const subcommand = /(?:analysis\s+execute|auth\s+describe)/i;
  return marker.test(command) && subcommand.test(command);
}

export function commandHasModelAuthFlags(command) {
  const skeleton = maskQuotedAndHeredocRegions(command);
  return /(?:^|\s)\\?--(?:data-auth|auth-blob|auth-json)\b/i.test(skeleton);
}

function matchesMetricInvocation(command, subcmd) {
  if (!String(command || "").trim()) return false;
  return metricInvocationRegexp(subcmd).test(maskQuotedAndHeredocRegions(command));
}

function metricInvocationRegexp(subcmd) {
  const binPattern = runtimeMetricBinPattern();
  return metricRegexp(
    `(?:^|[\\n;|&]|\\b(?:then|do|if|elif|else)\\b)\\s*` +
      String.raw`(?:cmd(?:\.exe)?\s+/(?:c|k)\s+)?` +
      String.raw`(?:(?:source|\.)\s+[^\s;|&]+\s*(?:&&\s*)?)*` +
      String.raw`(?:[A-Za-z_][\w]*=(?:'[^\n']*'|"[^\n"]*"|\S+)\s+)*` +
      String.raw`(?:'|")?` +
      binPattern +
      String.raw`(?:'|")?\s+` +
      subcmd +
      String.raw`\b`,
    "m",
  );
}

function runtimeMetricBinPattern() {
  if (WINDOWS) return `(?:${metricBinPattern}|${windowsMetricBinPattern})`;
  return metricBinPattern;
}

function metricRegexp(pattern, extraFlags = "") {
  let flags = `g${extraFlags}`;
  if (WINDOWS && !flags.includes("i")) flags += "i";
  return compile(pattern, flags);
}

function compile(pattern, flags) {
  const re = new RegExp(pattern, flags);
  re.execAll = (text) => {
    const out = [];
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      out.push([match.index, match.index + match[0].length]);
      if (match[0].length === 0) re.lastIndex += 1;
    }
    return out;
  };
  const origTest = re.test.bind(re);
  re.test = (text) => {
    re.lastIndex = 0;
    return origTest(text);
  };
  return re;
}

export function maskQuotedAndHeredocRegions(command) {
  if (!command) return "";
  const chars = [...command];
  const n = chars.length;
  const spaceOut = (from, to) => {
    for (let k = from; k < to && k < n; k++) {
      if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " ";
    }
  };
  const isProtectedVarQuote = (inner) => /^\s*\$\{?QDM_METRIC_CLI(?::-[^}]*)?\}?\s*$/.test(inner);
  const isWindowsMetricCLIPath = (inner) => {
    if (!WINDOWS) return false;
    return /^(?:(?:[A-Za-z]:[/\\])|(?:\.\.?[/\\])|\/)[^\r\n]*[/\\]qdm-metric-cli(?:\.exe)?$/i.test(inner.trim());
  };

  let i = 0;
  while (i < n) {
    if (chars[i] === "<" && i + 1 < n && chars[i + 1] === "<") {
      let j = i + 2;
      if (j < n && chars[j] === "-") j += 1;
      while (j < n && isSpace(chars[j])) j += 1;
      let quote = "";
      if (j < n && (chars[j] === "'" || chars[j] === '"')) {
        quote = chars[j];
        j += 1;
      }
      const tagStart = j;
      while (j < n && isIdent(chars[j])) j += 1;
      if (j > tagStart) {
        const tag = chars.slice(tagStart, j).join("");
        if (quote && j < n && chars[j] === quote) j += 1;
        let bodyStart = j;
        while (bodyStart < n && chars[bodyStart] !== "\n") bodyStart += 1;
        if (bodyStart < n) bodyStart += 1;
        let k = bodyStart;
        let closed = false;
        while (k < n) {
          if (k === bodyStart || chars[k - 1] === "\n") {
            let t = k;
            while (t < n && chars[t] === "\t") t += 1;
            const tagChars = [...tag];
            if (t + tagChars.length <= n && chars.slice(t, t + tagChars.length).join("") === tag) {
              const after = t + tagChars.length;
              if (after >= n || chars[after] === "\n" || chars[after] === "\r") {
                spaceOut(bodyStart, t);
                i = after;
                closed = true;
                break;
              }
            }
          }
          k += 1;
        }
        if (closed) continue;
        spaceOut(bodyStart, n);
        break;
      }
    }

    if (chars[i] === "'") {
      let j = i + 1;
      while (j < n && chars[j] !== "'") j += 1;
      if (j < n) {
        const inner = chars.slice(i + 1, j).join("");
        if (!isProtectedVarQuote(inner) && !isWindowsMetricCLIPath(inner)) spaceOut(i + 1, j);
        i = j + 1;
        continue;
      }
      spaceOut(i + 1, n);
      break;
    }

    if (chars[i] === "$" && i + 1 < n && chars[i + 1] === "'") {
      let j = i + 2;
      while (j < n) {
        if (chars[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (chars[j] === "'") break;
        j += 1;
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
        j += 1;
      }
      if (j < n) {
        const inner = chars.slice(i + 1, j).join("");
        if (!isProtectedVarQuote(inner) && !isWindowsMetricCLIPath(inner) && !isCMDWrapperCommandQuote(chars, i)) {
          spaceOut(i + 1, j);
        }
        i = j + 1;
        continue;
      }
      spaceOut(i + 1, n);
      break;
    }
    i += 1;
  }
  return chars.join("");
}

function isCMDWrapperCommandQuote(chars, quoteIndex) {
  if (!WINDOWS || quoteIndex <= 0) return false;
  const prefix = chars.slice(0, quoteIndex).join("").trimEnd();
  return /(?:^|[\n;|&])\s*cmd(?:\.exe)?\s+\/(?:c|k)\s*$/i.test(prefix);
}

export function rewriteMetricCliInvocation(command, metricCliPath, dialect) {
  if (!String(metricCliPath || "").trim() || !command) return command;
  const quoted = shellQuote(metricCliPath, firstDialect(dialect));
  let skeleton = maskQuotedAndHeredocRegions(command);
  if (firstDialect(dialect) === SHELL_CMD && isCMDQuotedCommandSegment(command)) {
    skeleton = command;
  }
  const binRe = metricRegexp(`(?:'|")?${runtimeMetricBinPattern()}(?:'|")?`);
  const matches = binRe.execAll(skeleton);
  if (matches.length === 0) return command;
  const invokeHereRe = metricRegexp(
    `^(?:'|")?${runtimeMetricBinPattern()}(?:'|")?\\s+(?:analysis\\s+execute|auth\\s+describe)\\b`,
  );
  let out = "";
  let last = 0;
  for (const match of matches) {
    if (!invokeHereRe.test(skeleton.slice(match[0]))) continue;
    out += command.slice(last, match[0]) + quoted;
    last = match[1];
  }
  return out + command.slice(last);
}

export function stripAuthFlags(command) {
  return stripAuthFlagsWithSkeleton(command, maskQuotedAndHeredocRegions(command));
}

export function stripAuthFlagsWithSkeleton(command, skeleton) {
  const re = /(?:^|\s)\\?--(?:data-auth\b|(?:auth-blob|auth-json)(?:\s*=\s*|\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;|&]+))/gi;
  const matches = [];
  let match;
  re.lastIndex = 0;
  while ((match = re.exec(skeleton))) {
    matches.push([match.index, match.index + match[0].length]);
  }
  if (matches.length === 0) return command.trim();
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += command.slice(last, m[0]);
    last = m[1];
  }
  return (out + command.slice(last)).trim();
}

export function injectDataAuth(command, blob, metricCliPath) {
  if (!String(metricCliPath || "").trim()) {
    const cleaned = stripAuthFlags(command);
    return insertFlagsBeforeShellTail(cleaned, ` --data-auth --auth-blob ${shellQuote(blob)}`, "execute");
  }
  return rewriteGatedMetricCommands(command, blob, metricCliPath);
}

export function injectAuthDescribeBlob(command, blob, metricCliPath) {
  if (!String(metricCliPath || "").trim()) {
    const cleaned = stripAuthFlags(command);
    return insertFlagsBeforeShellTail(cleaned, ` --auth-blob ${shellQuote(blob)}`, "describe");
  }
  return rewriteGatedMetricCommands(command, blob, metricCliPath);
}

export function rewriteGatedMetricCommands(command, blob, metricCliPath, dialect) {
  if (!String(metricCliPath || "").trim()) {
    throw new Error("qdm-metric-cli path is empty");
  }
  const activeDialect = firstDialect(dialect);
  if (activeDialect === SHELL_CMD) {
    const split = splitCMDWrapper(command);
    if (split) {
      const rewrittenInner = rewriteGatedMetricCommands(split.inner, blob, metricCliPath, SHELL_CMD);
      return `${split.prefix}"${rewrittenInner}"`;
    }
  }
  const invocations = findMetricInvocations(command);
  if (invocations.length === 0) throw new Error("no gated invocation found");

  let rewritten = command;
  const quotedCLI = shellQuote(metricCliPath, activeDialect);
  const quotedBlob = shellQuote(blob, activeDialect);
  for (let index = invocations.length - 1; index >= 0; index--) {
    const invocation = invocations[index];
    let segment = stripAuthFlags(command.slice(invocation.start, invocation.end));
    segment = rewriteMetricCliInvocation(segment, metricCliPath, activeDialect);
    const wrappedCMD = activeDialect === SHELL_CMD && segment.startsWith('"') && segment.endsWith('"');
    if (wrappedCMD) segment = segment.slice(0, -1);
    if (activeDialect === SHELL_POWERSHELL && !segment.trimStart().startsWith("&")) {
      segment = `& ${segment.trim()}`;
    }
    let flags = ` --auth-blob ${quotedBlob}`;
    if (invocation.kind === "analysis") flags = ` --data-auth${flags}`;
    let replacement = segment.replace(/[ \t]+$/, "") + flags;
    if (wrappedCMD) replacement += '"';
    let trustedCLIStart = replacement.trimStart().startsWith(`${quotedCLI} `);
    if (activeDialect === SHELL_POWERSHELL) {
      trustedCLIStart = trustedCLIStart || replacement.startsWith(`& ${quotedCLI} `);
    }
    if (activeDialect === SHELL_CMD && isCMDWrapperText(replacement)) {
      const trimmed = replacement.trimStart();
      trustedCLIStart =
        trimmed.startsWith(`cmd /c ${quotedCLI} `) ||
        trimmed.startsWith(`cmd /k ${quotedCLI} `) ||
        trimmed.startsWith(`cmd.exe /c ${quotedCLI} `) ||
        trimmed.startsWith(`cmd.exe /k ${quotedCLI} `);
    }
    if (activeDialect === SHELL_CMD && isCMDWrapperText(command)) {
      const trimmedReplacement = replacement.trim();
      trustedCLIStart =
        trustedCLIStart ||
        trimmedReplacement.startsWith(`${quotedCLI} `) ||
        trimmedReplacement.startsWith(`"${quotedCLI}" `);
    }
    if (!trustedCLIStart) {
      throw new Error("gated invocation did not bind the trusted CLI path");
    }
    if (
      countSubstr(replacement, "--auth-blob") !== 1 ||
      !replacement.includes(`--auth-blob ${quotedBlob}`) ||
      replacement.includes("--auth-json")
    ) {
      throw new Error("gated invocation did not bind exactly one runtime blob");
    }
    const dataAuthCount = countSubstr(replacement, "--data-auth");
    if ((invocation.kind === "analysis" && dataAuthCount !== 1) || (invocation.kind === "describe" && dataAuthCount !== 0)) {
      throw new Error("gated invocation has invalid data-auth flags");
    }
    rewritten = rewritten.slice(0, invocation.start) + replacement + rewritten.slice(invocation.end);
  }
  return rewritten;
}

function isCMDWrapperText(command) {
  return /^\s*cmd(?:\.exe)?\s+\/(?:c|k)\s+/i.test(command);
}

function splitCMDWrapper(command) {
  const match = /^(\s*cmd(?:\.exe)?\s+\/(?:c|k)\s+)"(.*)"\s*$/is.exec(command);
  if (!match) return null;
  return { prefix: match[1], inner: match[2] };
}

function isCMDQuotedCommandSegment(command) {
  const trimmed = command.trim();
  return WINDOWS && trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

function findMetricInvocations(command) {
  const skeleton = maskQuotedAndHeredocRegions(command);
  const invocations = [];
  for (const candidate of [
    { kind: "analysis", subcmd: String.raw`analysis\s+execute` },
    { kind: "describe", subcmd: String.raw`auth\s+describe` },
  ]) {
    const invocationRe = metricInvocationRegexp(candidate.subcmd);
    const commandRe = metricRegexp(
      `(?:'|")?${runtimeMetricBinPattern()}(?:'|")?\\s+${candidate.subcmd}\\b`,
    );
    for (const match of invocationRe.execAll(skeleton)) {
      const slice = skeleton.slice(match[0], match[1]);
      commandRe.lastIndex = 0;
      const relative = commandRe.exec(slice);
      if (!relative) continue;
      const start = match[0] + relative.index;
      const subcommandEnd = match[0] + relative.index + relative[0].length;
      const end = metricInvocationEnd(skeleton, subcommandEnd);
      invocations.push({ start, end, kind: candidate.kind });
    }
  }
  invocations.sort((a, b) => a.start - b.start);
  for (let index = 1; index < invocations.length; index++) {
    if (invocations[index - 1].end > invocations[index].start) {
      throw new Error("overlapping gated invocations cannot be safely rewritten");
    }
  }
  return invocations;
}

function metricInvocationEnd(skeleton, from) {
  const tail = skeleton.slice(from);
  const operator = /\s*(?:\|\||&&|[|;]|[0-9]*>|&>|\n)/m.exec(tail);
  if (!operator) return skeleton.length;
  return from + operator.index;
}

export function insertFlagsBeforeShellTail(command, flags, anchorWord) {
  const skeleton = maskQuotedAndHeredocRegions(command);
  let subcmd = String.raw`analysis\s+execute`;
  if (anchorWord === "describe") subcmd = String.raw`auth\s+describe`;
  const inv = metricRegexp(`(?:'|")?${runtimeMetricBinPattern()}(?:'|")?\\s+${subcmd}\\b`).exec(skeleton);
  let fromAnchor = -1;
  if (inv) {
    const lower = skeleton.slice(inv.index, inv.index + inv[0].length).toLowerCase();
    const rel = lower.lastIndexOf(anchorWord.toLowerCase());
    if (rel >= 0) fromAnchor = inv.index + rel;
  }
  if (fromAnchor < 0) {
    const loc = new RegExp(`\\b${escapeRegExp(anchorWord)}\\b`, "i").exec(command);
    if (!loc) return command + flags;
    fromAnchor = loc.index;
  }
  const tail = command.slice(fromAnchor);
  const op = /\s(?:\||&&|;|2?>|1?>|&>)/.exec(tail);
  if (!op) return command + flags;
  const abs = fromAnchor + op.index;
  return command.slice(0, abs) + flags + command.slice(abs);
}

export function shellQuote(value, dialect) {
  if (firstDialect(dialect) === SHELL_CMD) {
    return `"${String(value).replaceAll('"', '\\"')}"`;
  }
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function firstDialect(dialect) {
  if (Array.isArray(dialect)) dialect = dialect[0];
  return dialect || SHELL_BASH;
}

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isIdent(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

function countSubstr(value, part) {
  let count = 0;
  let from = 0;
  while (from < value.length) {
    const idx = value.indexOf(part, from);
    if (idx < 0) break;
    count += 1;
    from = idx + part.length;
  }
  return count;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { SHELL_BASH, SHELL_CMD, SHELL_POWERSHELL };
