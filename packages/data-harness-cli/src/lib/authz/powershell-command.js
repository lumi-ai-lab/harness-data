import { stripAuthFlagsWithSkeleton } from "./metric-command.js";

const powerShellMetricExecutablePattern =
  String.raw`(?:"[^"\r\n]*qdm-metric-cli(?:\.exe)?"|'[^'\r\n]*qdm-metric-cli(?:\.exe)?'|\$env:QDM_METRIC_CLI|(?:[A-Za-z]:)?(?:\.{0,2}[\\/])?(?:[^\s;|&'` +
  "`" +
  String.raw`]+[\\/])*qdm-metric-cli(?:\.exe)?|qdm-metric-cli(?:\.exe)?)`;

export function isPowerShellMetricAnalysisExecute(command) {
  return powerShellInvocationRegexp(String.raw`analysis\s+execute`).test(maskPowerShellRegions(command));
}

export function isPowerShellMetricAuthDescribe(command) {
  return powerShellInvocationRegexp(String.raw`auth\s+describe`).test(maskPowerShellRegions(command));
}

export function isPowerShellMetricAuthzGatedCommand(command) {
  return isPowerShellMetricAnalysisExecute(command) || isPowerShellMetricAuthDescribe(command);
}

export function powerShellMetricInvocationCount(command) {
  const re = powerShellInvocationRegexp(String.raw`(?:analysis\s+execute|auth\s+describe)`);
  const skeleton = maskPowerShellRegions(command);
  return [...skeleton.matchAll(new RegExp(re.source, `${re.flags}g`))].length;
}

export function powerShellCommandHasModelAuthFlags(command) {
  return /(?:^|\s)--(?:data-auth|auth-blob|auth-json)\b/i.test(maskPowerShellRegions(command));
}

function powerShellInvocationRegexp(subcommand) {
  return new RegExp(
    `(?:^|[\\r\\n;|]|&&)\\s*(?:\\$[A-Za-z_][\\w]*\\s*=\\s*)?(?:&\\s*)?${powerShellMetricExecutablePattern}\\s+${subcommand}\\b`,
    "im",
  );
}

export function rewritePowerShellMetricCLIInvocation(command, metricCLIPath) {
  if (!String(command || "").trim() || !String(metricCLIPath || "").trim()) return command;
  return rewritePowerShellMetricCLIExecutable(command, powerShellQuote(metricCLIPath));
}

function rewritePowerShellMetricCLIExecutable(command, replacement) {
  const skeleton = maskPowerShellRegions(command);
  const re = new RegExp(
    `(?:^|[\\r\\n;|]|&&)(\\s*)(?:\\$[A-Za-z_][\\w]*\\s*=\\s*)?(&\\s*)?(${powerShellMetricExecutablePattern})(\\s+)(?:analysis\\s+execute|auth\\s+describe)\\b`,
    "gim",
  );
  const matches = [];
  let match;
  while ((match = re.exec(skeleton))) {
    matches.push(match);
  }
  if (matches.length === 0) return command;
  let out = "";
  let last = 0;
  for (const m of matches) {
    const execStart = m.index + m[0].indexOf(m[3]);
    const execEnd = execStart + m[3].length;
    const amp = m[2];
    out += command.slice(last, execStart);
    if (amp == null) out += "& ";
    out += replacement;
    last = execEnd;
  }
  return out + command.slice(last);
}

export function stripPowerShellAuthFlags(command) {
  return stripAuthFlagsWithSkeleton(command, maskPowerShellRegions(command));
}

export function injectPowerShellDataAuth(command, blob, metricCLIPath) {
  let cleaned = stripPowerShellAuthFlags(command);
  cleaned = rewritePowerShellMetricCLIInvocation(cleaned, metricCLIPath);
  return insertPowerShellFlags(cleaned, ` --data-auth --auth-blob ${powerShellQuote(blob)}`, "execute");
}

export function injectPowerShellAuthDescribeBlob(command, blob, metricCLIPath) {
  let cleaned = stripPowerShellAuthFlags(command);
  cleaned = rewritePowerShellMetricCLIInvocation(cleaned, metricCLIPath);
  return insertPowerShellFlags(cleaned, ` --auth-blob ${powerShellQuote(blob)}`, "describe");
}

function insertPowerShellFlags(command, flags, anchorWord) {
  const skeleton = maskPowerShellRegions(command);
  let subcommand = String.raw`analysis\s+execute`;
  if (anchorWord === "describe") subcommand = String.raw`auth\s+describe`;
  const invocation = powerShellInvocationRegexp(subcommand).exec(skeleton);
  if (!invocation) return command;
  const segment = skeleton.slice(invocation.index, invocation.index + invocation[0].length).toLowerCase();
  const relativeAnchor = segment.lastIndexOf(anchorWord.toLowerCase());
  if (relativeAnchor < 0) return command;
  const anchorEnd = invocation.index + relativeAnchor + anchorWord.length;
  const tail = skeleton.slice(anchorEnd);
  const op = /\s(?:\||&&|;|2?>|1?>|&>)/.exec(tail);
  if (!op) return command + flags;
  const position = anchorEnd + op.index;
  return command.slice(0, position) + flags + command.slice(position);
}

export function powerShellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function maskPowerShellRegions(command) {
  if (!command) return "";
  const masked = Buffer.from(command, "utf8");
  const space = (from, to) => {
    for (let i = from; i < to && i < masked.length; i++) {
      if (masked[i] !== 0x0d && masked[i] !== 0x0a) masked[i] = 0x20;
    }
  };
  const text = command;
  for (let i = 0; i < text.length; ) {
    if (
      i + 2 < text.length &&
      text[i] === "@" &&
      (text[i + 1] === "'" || text[i + 1] === '"') &&
      (text[i + 2] === "\r" || text[i + 2] === "\n")
    ) {
      const quote = text[i + 1];
      const endMarker = `\n${quote}@`;
      const endRel = text.indexOf(endMarker, i + 2);
      if (endRel < 0) {
        space(i, text.length);
        break;
      }
      const end = endRel + endMarker.length;
      space(i, end);
      i = end;
      continue;
    }
    if (text[i] === "#") {
      const end = text.indexOf("\n", i);
      if (end < 0) {
        space(i, text.length);
        break;
      }
      space(i, end);
      i = end;
      continue;
    }
    if (text[i] === "'" || text[i] === '"') {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length) {
        if (quote === "'" && text[j] === "'" && j + 1 < text.length && text[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (quote === '"' && text[j] === "`" && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (text[j] === quote) break;
        j += 1;
      }
      if (j >= text.length) {
        space(i + 1, text.length);
        break;
      }
      if (!isPowerShellMetricExecutable(text.slice(i + 1, j))) {
        space(i + 1, j);
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return masked.toString("utf8");
}

function isPowerShellMetricExecutable(value) {
  value = value.trim().replaceAll("\\", "/");
  const lower = value.toLowerCase();
  if (lower === "$env:qdm_metric_cli") return true;
  const parts = lower.split("/");
  const base = parts[parts.length - 1];
  return base === "qdm-metric-cli" || base === "qdm-metric-cli.exe";
}
