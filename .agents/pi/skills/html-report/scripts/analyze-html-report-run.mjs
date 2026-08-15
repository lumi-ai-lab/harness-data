#!/usr/bin/env node
/** Analyze one html-report self-test run and write JSON/Chinese Markdown. */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPORT_STAGE_ORDER = Object.freeze([
  "A_CONFIG", "A_CONFIRM", "B0_PREFLIGHT", "B2_WRITER",
  "B25_EDITOR", "B3_RESEARCH", "B4_REVIEW", "B5_DESIGN",
]);
const PRODUCER = "analyze-html-report-run.mjs";
export const DEFAULT_PERFORMANCE_CONFIG_PATH = resolve(
  new URL("../html-report-self-test.config.json", import.meta.url).pathname
);
const RETRIES = new Set(["auto_retry_start", "summarization_retry_scheduled", "summarization_retry_attempt_start"]);
const INDICATORS = /qdm-indicators|indicators-cli|ack_cli_data|fetch_report_entry|fetch_explore|fetch-entry|fetch-explore/i;
const SCRIPTS = /check-session-layout|assemble-report|quality-scan|prepare-research-evidence|write-verdict|submit-review-scorecard|compile-report|compose-report|render-report|capture-report|finalize-design/i;
const INFRA = /token|unauthori[sz]ed|\b40[13]\s+(?:forbidden|unauthori[sz]ed)\b|network|provider|rate.?limit|(?:http|status|response|code)[^\n]{0,16}\b(?:401|403|5\d\d)\b|ECONN|ENOTFOUND|backend|CAS|认证|网络|限流/i;

const obj = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const arr = (value) => Array.isArray(value) ? value : [];
const pick = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
function numeric(...values) {
  const value = Number(pick(...values));
  return Number.isFinite(value) ? value : null;
}
function asIso(...values) {
  const value = pick(...values);
  const stamp = Date.parse(value || "");
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}
function elapsed(start, end) {
  const a = Date.parse(start || "");
  const b = Date.parse(end || "");
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}
function absolute(value, base) {
  if (typeof value !== "string" || !value) return null;
  return resolve(isAbsolute(value) ? value : join(base, value));
}
function stageId(value) {
  const key = String(value || "").toUpperCase().replace(/[.\s-]+/g, "_");
  return ({
    A: "A_CONFIG", ACONFIG: "A_CONFIG", A_CONFIG: "A_CONFIG", A_CONFIRM: "A_CONFIRM",
    B0: "B0_PREFLIGHT", B0_PREFLIGHT: "B0_PREFLIGHT",
    B2: "B2_WRITER", B2_WRITER: "B2_WRITER",
    B25: "B25_EDITOR", B2_5: "B25_EDITOR", B25_EDITOR: "B25_EDITOR",
    B3: "B3_RESEARCH", B3_RESEARCH: "B3_RESEARCH",
    B4: "B4_REVIEW", B4_REVIEW: "B4_REVIEW",
    B5: "B5_DESIGN", B5_DESIGN: "B5_DESIGN",
  })[key] || null;
}
const at = (event) => asIso(event.timestamp, event.occurredAt, event.at, event.receivedAt, event.recordedAt);
function normalizedRpc(records) {
  return arr(records).map((record, index) => {
    const envelope = obj(record);
    const event = obj(envelope.event);
    return Object.keys(event).length
      ? { ...envelope, ...event, timestamp: pick(event.timestamp, envelope.timestamp, envelope.receivedAt, envelope.recordedAt), _index: index }
      : { ...envelope, _index: index };
  });
}
const observedStage = (value) => stageId(pick(value.stageId, value.stage, value.currentStage, value.id));
function stageForEvent(event, index, observations) {
  const explicit = observedStage(event);
  if (explicit) return explicit;
  for (const observation of observations) {
    const id = observedStage(observation);
    if (!id) continue;
    const from = numeric(observation.rpcStartIndex, observation.eventStartIndex);
    const to = numeric(observation.rpcEndIndex, observation.eventEndIndex);
    if (from !== null && index >= from && (to === null || index <= to)) return id;
    const stamp = Date.parse(at(event) || "");
    const start = Date.parse(pick(observation.startedAt, observation.startAt) || "");
    const end = Date.parse(pick(observation.endedAt, observation.settledAt, observation.endAt) || "");
    if (Number.isFinite(stamp) && Number.isFinite(start) && stamp >= start && (!Number.isFinite(end) || stamp <= end)) return id;
  }
  return null;
}
function pipelineEventScopes(pipeline, run) {
  return REPORT_STAGE_ORDER.flatMap((id) => {
    const ledger = obj(obj(pipeline.stages)[id]);
    const startedAt = asIso(ledger.startedAt, arr(ledger.attempts).at(-1)?.startedAt);
    if (!startedAt) return [];
    const endedAt = asIso(
      ledger.completedAt,
      ledger.failedAt,
      arr(ledger.attempts).at(-1)?.endedAt,
      id === stageId(pick(run.stoppedStage, pipeline.currentStage)) ? run.endedAt : null
    );
    return [{ stageId: id, startedAt, endedAt }];
  });
}
function toolArguments(event) {
  return { ...obj(event.input), ...obj(event.args) };
}
function agents(event) {
  const input = toolArguments(event);
  const found = [];
  if (typeof input.agent === "string") found.push(input.agent);
  for (const task of arr(input.tasks)) if (typeof task?.agent === "string") found.push(task.agent);
  for (const step of arr(input.chain)) {
    if (typeof step?.agent === "string") found.push(step.agent);
    for (const task of arr(step?.parallel)) if (typeof task?.agent === "string") found.push(task.agent);
    if (typeof step?.parallel?.agent === "string") found.push(step.parallel.agent);
  }
  return [...new Set(found)];
}
function eventMs(event, started) {
  return numeric(event.durationMs, event.elapsedMs, obj(event.details).durationMs) ??
    elapsed(started?.startedAt, at(event)) ?? 0;
}
function subagentResultDetails(event) {
  return Object.keys(obj(event.details)).length
    ? obj(event.details)
    : obj(obj(event.result).details);
}
function autoSubagentBridges(event) {
  const resultDetails = obj(obj(event.result).details);
  const eventDetails = obj(event.details);
  const candidates = [
    resultDetails.qdmHarnessAutoSubagent,
    resultDetails.qdmHarnessAutoResearcher,
    eventDetails.qdmHarnessAutoSubagent,
    eventDetails.qdmHarnessAutoResearcher,
  ];
  const bridges = [];
  const requestIds = new Set();
  for (const candidate of candidates) {
    const bridge = obj(candidate);
    if (
      bridge.version === 1 &&
      bridge.producer === "qdm-harness" &&
      bridge.mechanism === "extension-event-bridge"
    ) {
      const requestId = String(pick(bridge.requestId, ""));
      if (requestId && requestIds.has(requestId)) continue;
      if (requestId) requestIds.add(requestId);
      bridges.push(bridge);
    }
  }
  return bridges;
}
function structuredSubagentFailure(details) {
  return arr(obj(details).results).some((result) =>
    (result?.exitCode !== undefined && Number(result.exitCode) !== 0) ||
    result?.structuredOutput?.status === "failed"
  );
}
function transcriptPathOf(result) {
  return pick(
    result?.transcriptPath,
    result?.transcript,
    obj(result?.artifactPaths).transcriptPath,
    obj(result?.artifacts).transcriptPath
  );
}
function stageTools(id, events, observations) {
  const starts = new Map();
  const toolMap = new Map();
  const agentMap = new Map();
  const transcripts = new Set();
  let indicatorsCliDurationMs = 0;
  let deterministicScriptDurationMs = 0;
  for (const [index, event] of events.entries()) {
    const callId = pick(event.toolCallId, event.id);
    if (event.type === "tool_execution_start" && callId) {
      starts.set(callId, {
        startedAt: at(event),
        toolName: event.toolName,
        args: toolArguments(event),
        stageId: stageForEvent(event, index, observations),
      });
      continue;
    }
    if (event.type !== "tool_execution_end") continue;
    const started = starts.get(callId);
    const bridges = autoSubagentBridges(event);
    const outerStage = pick(started?.stageId, stageForEvent(event, index, observations));
    const stageBridges = bridges.filter((bridge) => stageId(bridge.stageId) === id);
    const includeOuter = outerStage === id;
    if (!includeOuter && stageBridges.length === 0) continue;
    const effectiveEvent = {
      ...event,
      toolName: pick(event.toolName, started?.toolName),
      args: { ...obj(started?.args), ...toolArguments(event) },
    };
    const totalDurationMs = eventMs(event, started);
    const totalBridgeDurationMs = bridges.reduce((sum, bridge) =>
      sum + (numeric(bridge.durationMs) ?? elapsed(bridge.startedAt, bridge.endedAt) ?? 0), 0);
    const outerDurationMs = Math.max(0, totalDurationMs - totalBridgeDurationMs);
    const name = String(effectiveEvent.toolName || "unknown-tool");
    const resultDetails = subagentResultDetails(event);
    const structuredFailure = name.toLowerCase() === "subagent" && structuredSubagentFailure(resultDetails);
    const outerFailure = bridges.length === 0 && (event.isError === true || structuredFailure);
    if (includeOuter) {
      const tool = toolMap.get(name) || { toolName: name, calls: 0, durationMs: 0, failures: 0 };
      tool.calls += 1;
      tool.durationMs += outerDurationMs;
      if (outerFailure) tool.failures += 1;
      toolMap.set(name, tool);
      const argumentsValue = toolArguments(effectiveEvent);
      const command = [name, argumentsValue.command, argumentsValue.task].filter(Boolean).join(" ");
      if (INDICATORS.test(command)) indicatorsCliDurationMs += outerDurationMs;
      if (SCRIPTS.test(command)) deterministicScriptDurationMs += outerDurationMs;
      if (name.toLowerCase() === "subagent") {
        const agentNames = agents(effectiveEvent);
        for (const agentName of agentNames.length ? agentNames : ["unknown-subagent"]) {
          const agent = agentMap.get(agentName) || { agent: agentName, dispatches: 0, durationMs: 0, failures: 0 };
          agent.dispatches += 1;
          agent.durationMs += outerDurationMs;
          if (outerFailure) agent.failures += 1;
          agentMap.set(agentName, agent);
        }
        for (const result of arr(resultDetails.results)) {
          const path = transcriptPathOf(result);
          if (typeof path === "string") transcripts.add(path);
        }
        const directResult = obj(event.result);
        const directTranscript = transcriptPathOf(directResult);
        if (typeof directTranscript === "string") transcripts.add(directTranscript);
      }
    }
    for (const bridge of stageBridges) {
      const bridgeDurationMs = numeric(bridge.durationMs) ?? elapsed(bridge.startedAt, bridge.endedAt) ?? 0;
      const bridgeDetails = obj(bridge.resultDetails);
      const bridgeFailure = bridge.isError === true || structuredSubagentFailure(bridgeDetails);
      const agentName = String(pick(bridge.agent, "unknown-subagent"));
      const agent = agentMap.get(agentName) || { agent: agentName, dispatches: 0, durationMs: 0, failures: 0 };
      agent.dispatches += 1;
      agent.durationMs += bridgeDurationMs;
      if (bridgeFailure) agent.failures += 1;
      agentMap.set(agentName, agent);
      for (const result of arr(bridgeDetails.results)) {
        const path = transcriptPathOf(result);
        if (typeof path === "string") transcripts.add(path);
      }
    }
  }
  return {
    tools: [...toolMap.values()].sort((a, b) => a.toolName.localeCompare(b.toolName)),
    subagents: [...agentMap.values()].sort((a, b) => a.agent.localeCompare(b.agent)),
    indicatorsCliDurationMs, deterministicScriptDurationMs, transcripts: [...transcripts],
  };
}
function subagentTranscriptBindings(events, observations, base) {
  const starts = new Map();
  const bindings = new Map();
  for (const [index, event] of events.entries()) {
    const callId = pick(event.toolCallId, event.id);
    if (event.type === "tool_execution_start" && callId) {
      starts.set(callId, {
        toolName: event.toolName,
        args: toolArguments(event),
        stageId: stageForEvent(event, index, observations),
      });
      continue;
    }
    if (event.type !== "tool_execution_end") continue;
    const started = starts.get(callId);
    const effectiveEvent = {
      ...event,
      toolName: pick(event.toolName, started?.toolName),
      args: { ...obj(started?.args), ...toolArguments(event) },
    };
    const stage = pick(started?.stageId, stageForEvent(event, index, observations));
    const fallbackAgents = agents(effectiveEvent);
    const add = (result, resultIndex = 0, resultStage = stage, resultAgents = fallbackAgents) => {
      const path = absolute(transcriptPathOf(result), base);
      if (!path) return;
      const agent = String(pick(result?.agent, resultAgents[resultIndex], resultAgents[0], "unknown-subagent"));
      const previous = bindings.get(path);
      bindings.set(path, {
        path,
        stageId: stageId(pick(resultStage, previous?.stageId)),
        agent: agent === "unknown-subagent" ? previous?.agent || agent : agent,
      });
    };
    for (const bridge of autoSubagentBridges(event)) {
      const bridgeAgent = String(pick(bridge.agent, "unknown-subagent"));
      arr(obj(bridge.resultDetails).results).forEach((result, resultIndex) =>
        add(result, resultIndex, pick(stageId(bridge.stageId), stage), [bridgeAgent])
      );
    }
    if (String(effectiveEvent.toolName || "").toLowerCase() !== "subagent") continue;
    arr(subagentResultDetails(event).results).forEach((result, resultIndex) => add(result, resultIndex));
    add(obj(event.result));
  }
  return [...bindings.values()];
}
function mergedTranscriptData(extracted, supplied, base) {
  const values = new Map();
  const add = (value) => {
    const source = typeof value === "string" ? { path: value } : obj(value);
    const path = absolute(pick(source.path, source.transcriptPath, source.transcript), base);
    if (!path) return;
    const previous = values.get(path) || {};
    values.set(path, {
      ...previous,
      ...source,
      path,
      stageId: stageId(pick(source.stageId, source.stage, previous.stageId)),
      agent: String(pick(source.agent, previous.agent, "unknown-subagent")),
      records: Array.isArray(source.records) ? source.records : arr(previous.records),
      recordsProvided: Array.isArray(source.records) || previous.recordsProvided === true,
    });
  };
  extracted.forEach(add);
  arr(supplied).forEach(add);
  return [...values.values()];
}
function messageText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join("\n");
  const source = obj(value);
  return String(pick(source.errorMessage, source.text, source.error, source.message, ""));
}
function conciseReason(value, fallback) {
  const text = String(pick(value, fallback)).trim();
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 1200);
}
function transcriptToolCalls(record) {
  const message = obj(record.message);
  if (pick(record.role, message.role) !== "assistant") return [];
  return arr(message.content).filter((item) => item?.type === "toolCall" && item?.name).map((item) => ({
    id: item.id || null,
    name: String(item.name),
    arguments: obj(item.arguments),
  }));
}
function transcriptFailure(record) {
  const message = obj(record.message);
  const role = pick(record.role, message.role);
  if (role === "toolResult" && (record.isError === true || message.isError === true)) {
    const toolName = String(pick(record.toolName, message.toolName, "unknown-tool"));
    return {
      code: "SUBAGENT_TOOL_FAILED",
      toolName,
      reason: conciseReason(
        pick(record.error, message.error, record.text, messageText(message.content)),
        `${toolName} 执行失败`
      ),
    };
  }
  const stopReason = pick(record.stopReason, message.stopReason);
  if (role === "assistant" && ["error", "aborted"].includes(stopReason)) {
    return {
      code: `SUBAGENT_ASSISTANT_${String(stopReason).toUpperCase()}`,
      toolName: null,
      reason: conciseReason(
        pick(
          message.errorMessage,
          record.errorMessage,
          message.error,
          record.error,
          record.text,
          messageText(message.content)
        ),
        `子代理 Assistant stopReason=${stopReason}`
      ),
    };
  }
  return null;
}
function analyzeSubagentTranscripts(data) {
  const issues = [];
  const summaries = new Map();
  for (const binding of data) {
    const summaryKey = `${binding.stageId || "unknown"}|${binding.agent}`;
    const summary = summaries.get(summaryKey) || {
      stageId: binding.stageId,
      agent: binding.agent,
      paths: new Set(),
      failureCount: 0,
      retryCount: 0,
      indicatorsCliDurationMs: 0,
      deterministicScriptDurationMs: 0,
    };
    summary.paths.add(binding.path);
    summaries.set(summaryKey, summary);
    const queued = new Map();
    const active = new Map();
    let pendingFailure = null;
    for (const [index, record] of arr(binding.records).entries()) {
      const failure = transcriptFailure(record);
      if (failure) {
        const issue = {
          classification: classification(failure.reason, "subagent-transcript"),
          code: failure.code,
          reason: failure.reason,
          occurredAt: at(record),
          stageId: binding.stageId,
          source: "subagent-transcript",
          toolOrAgent: failure.toolName || binding.agent,
          agent: binding.agent,
          toolName: failure.toolName,
          evidence: `${binding.path}:${index + 1}`,
          sequence: index,
        };
        issues.push(issue);
        summary.failureCount += 1;
        pendingFailure = issue;
      }

      const calls = transcriptToolCalls(record);
      for (const call of calls) {
        const queue = queued.get(call.name) || [];
        queue.push(call);
        queued.set(call.name, queue);
        if (!pendingFailure) continue;
        if (call.name === "structured_output") {
          pendingFailure = null;
          continue;
        }
        issues.push({
          classification: "PRODUCT_CONTRACT",
          code: "SUBAGENT_FAILURE_RETRY",
          reason: `${binding.agent} 在 ${pendingFailure.toolName || pendingFailure.code} 失败后继续调用 ${call.name}，形成恢复/重试链`,
          occurredAt: at(record),
          stageId: binding.stageId,
          source: "subagent-transcript",
          toolOrAgent: binding.agent,
          agent: binding.agent,
          toolName: call.name,
          evidence: `${binding.path}:${index + 1}`,
          sequence: index,
        });
        summary.retryCount += 1;
        pendingFailure = null;
      }

      const name = String(record.toolName || "");
      if (record.recordType === "tool_start" && name) {
        const queue = queued.get(name) || [];
        const call = queue.shift() || { name, arguments: { command: record.argsPreview } };
        queued.set(name, queue);
        const running = active.get(name) || [];
        running.push({ startedAt: at(record), call });
        active.set(name, running);
        if (pendingFailure) {
          if (name === "structured_output") pendingFailure = null;
          else {
            issues.push({
              classification: "PRODUCT_CONTRACT",
              code: "SUBAGENT_FAILURE_RETRY",
              reason: `${binding.agent} 在 ${pendingFailure.toolName || pendingFailure.code} 失败后继续调用 ${name}，形成恢复/重试链`,
              occurredAt: at(record),
              stageId: binding.stageId,
              source: "subagent-transcript",
              toolOrAgent: binding.agent,
              agent: binding.agent,
              toolName: name,
              evidence: `${binding.path}:${index + 1}`,
              sequence: index,
            });
            summary.retryCount += 1;
            pendingFailure = null;
          }
        }
      } else if (record.recordType === "tool_end" && name) {
        const running = active.get(name) || [];
        const started = running.shift();
        active.set(name, running);
        const durationMs = numeric(record.durationMs, record.elapsedMs) ?? elapsed(started?.startedAt, at(record)) ?? 0;
        const command = [name, started?.call?.arguments?.command, record.argsPreview].filter(Boolean).join(" ");
        if (INDICATORS.test(command)) summary.indicatorsCliDurationMs += durationMs;
        if (SCRIPTS.test(command)) summary.deterministicScriptDurationMs += durationMs;
      }
    }
  }
  return {
    issues,
    summaries: [...summaries.values()].map((summary) => ({ ...summary, paths: [...summary.paths].sort() })),
  };
}
function stageForTimestamp(record, observations) {
  const stamp = Date.parse(at(record) || record?.timestamp || "");
  if (!Number.isFinite(stamp)) return null;
  for (const observation of observations) {
    const id = observedStage(observation);
    const start = Date.parse(pick(observation.startedAt, observation.startAt) || "");
    const end = Date.parse(pick(observation.endedAt, observation.settledAt, observation.endAt) || "");
    if (id && Number.isFinite(start) && stamp >= start && (!Number.isFinite(end) || stamp <= end)) return id;
  }
  return null;
}
function analyzePiSessionRecords(records, path, observations, observation = {}) {
  const issues = [];
  let messageCount = 0;
  let toolCallCount = 0;
  let assistantFailureCount = 0;
  for (const [index, record] of arr(records).entries()) {
    const message = obj(record.message);
    if (record.type === "message" || Object.keys(message).length) messageCount += 1;
    if (message.role === "assistant") {
      toolCallCount += arr(message.content).filter((item) => item?.type === "toolCall").length;
      if (["error", "aborted"].includes(message.stopReason)) {
        assistantFailureCount += 1;
        const reason = conciseReason(
          pick(
            message.errorMessage,
            record.errorMessage,
            message.error,
            record.error,
            messageText(message.content)
          ),
          `Pi Session Assistant stopReason=${message.stopReason}`
        );
        issues.push({
          classification: classification(reason, "pi-session"),
          code: `PI_SESSION_ASSISTANT_${String(message.stopReason).toUpperCase()}`,
          reason,
          occurredAt: at(record),
          stageId: stageForTimestamp(record, observations),
          source: "pi-session",
          toolOrAgent: "parent-assistant",
          evidence: path ? `${path}:${index + 1}` : `Pi Session record #${index + 1}`,
          sequence: index,
        });
      }
    }
  }
  return {
    issues,
    summary: {
      path: path || null,
      status: observation.status || (Array.isArray(records) ? "provided" : "not_loaded"),
      recordCount: arr(records).length,
      messageCount,
      toolCallCount,
      assistantFailureCount,
      error: observation.error || null,
    },
  };
}
function stageBudget(id, run, checkpoint, observation, config) {
  const sources = [obj(observation.budget), obj(checkpoint.budget), obj(obj(run.budgets)[id]), obj(obj(run.performanceBudgets)[id]), obj(obj(config.performanceBudgets)[id])];
  return {
    softMs: pick(...sources.map((value) => numeric(value.softMs, value.softThresholdMs))) ?? null,
    hardMs: pick(...sources.map((value) => numeric(value.hardMs, value.hardTimeoutMs))) ?? null,
  };
}
function layoutOf(checkpoint, observation) {
  const source = pick(observation.layout, checkpoint.layout, observation.layoutCheck, checkpoint.layoutCheck);
  if (typeof source === "boolean") return { status: source ? "pass" : "fail", phase: null, reason: null };
  const layout = obj(source);
  const value = String(pick(layout.status, layout.result, layout.ok === true ? "pass" : null, layout.ok === false ? "fail" : null, "unknown")).toLowerCase();
  return {
    status: ["pass", "passed", "ok", "success"].includes(value) ? "pass" : ["fail", "failed", "error"].includes(value) ? "fail" : "unknown",
    phase: pick(layout.phase, checkpoint.layoutPhase, observation.layoutPhase) || null,
    reason: pick(layout.reason, layout.error, layout.message) || null,
  };
}
function classification(reason, source = "") {
  if (/self.?test|controller|analy[sz]er|fixture|RPC protocol|测试控制器/i.test(`${source} ${reason}`)) return "TEST_HARNESS";
  return INFRA.test(reason) ? "INFRASTRUCTURE" : "PRODUCT_CONTRACT";
}
function explicitIssues(source, sourceName, fallbackStage) {
  const values = [
    ...arr(source.anomalies),
    ...arr(source.performanceAnomalies),
    ...arr(source.errors),
    ...(source.firstAnomaly ? [source.firstAnomaly] : []),
    ...(source.anomaly ? [source.anomaly] : []),
    ...(source.performanceAnomaly ? [source.performanceAnomaly] : []),
    ...(source.error ? [source.error] : []),
  ];
  return values.map((item, index) => {
    const issue = typeof item === "string" ? { reason: item } : obj(item);
    const reason = String(pick(issue.reason, issue.message, issue.error, item, "未说明异常"));
    return {
      classification: pick(issue.classification, issue.category) || classification(reason, sourceName),
      code: pick(issue.code, issue.type) || `${sourceName.toUpperCase()}_ERROR`, reason,
      occurredAt: asIso(issue.occurredAt, issue.timestamp, source.observedAt, source.endedAt),
      stageId: stageId(pick(issue.stageId, issue.stage, fallbackStage)), source: sourceName,
      toolOrAgent: pick(issue.toolOrAgent, issue.toolName, issue.agent) || null,
      evidence: pick(issue.evidence, issue.log, issue.path) || null, sequence: index,
    };
  });
}
function rpcIssues(events, observations) {
  const starts = new Map();
  const issues = [];
  for (const [index, event] of events.entries()) {
    const callId = pick(event.toolCallId, event.id);
    if (event.type === "tool_execution_start" && callId) {
      starts.set(callId, {
        toolName: event.toolName,
        args: toolArguments(event),
        stageId: stageForEvent(event, index, observations),
      });
      continue;
    }
    const started = starts.get(callId);
    const effectiveEvent = {
      ...event,
      toolName: pick(event.toolName, started?.toolName),
      args: { ...obj(started?.args), ...toolArguments(event) },
    };
    let code;
    let reason;
    if (event.type === "extension_error") {
      code = "EXTENSION_ERROR";
      reason = String(pick(event.error, event.message, obj(event.details).error, "Pi extension_error"));
    } else if (event.type === "message_end" && event.message?.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason)) {
      code = `ASSISTANT_${event.message.stopReason.toUpperCase()}`;
      reason = conciseReason(
        pick(
          event.message.errorMessage,
          event.errorMessage,
          event.message.error,
          event.error,
          messageText(event.message.content)
        ),
        `Assistant stopReason=${event.message.stopReason}`
      );
    } else if (event.type === "tool_execution_end" && String(effectiveEvent.toolName || "").toLowerCase() === "subagent") {
      const details = Object.keys(obj(event.details)).length
        ? obj(event.details)
        : obj(obj(event.result).details);
      const failed = arr(details.results).find((result) =>
        (result?.exitCode !== undefined && Number(result.exitCode) !== 0) ||
        result?.structuredOutput?.status === "failed"
      );
      if (failed) {
        code = failed?.structuredOutput?.status === "failed"
          ? "SUBAGENT_STRUCTURED_FAILED"
          : "SUBAGENT_EXECUTION_FAILED";
        reason = String(pick(
          failed?.structuredOutput?.error,
          failed?.error,
          failed?.stderr,
          `${failed?.agent || "subagent"} 执行失败`
        ));
      } else if (event.isError === true) {
        code = "TOOL_EXECUTION_FAILED";
        const resultText = arr(obj(event.result).content).find((item) => item?.type === "text")?.text;
        reason = String(pick(event.error, obj(event.details).error, resultText, "subagent 执行失败"));
      } else continue;
    } else if (event.type === "tool_execution_end" && event.isError === true) {
      code = "TOOL_EXECUTION_FAILED";
      const resultText = arr(obj(event.result).content).find((item) => item?.type === "text")?.text;
      reason = String(pick(event.error, obj(event.details).error, resultText, `${effectiveEvent.toolName || "tool"} 执行失败`));
    } else continue;
    issues.push({
      classification: classification(reason, "rpc"),
      code,
      reason,
      occurredAt: at(event),
      stageId: pick(started?.stageId, stageForEvent(event, index, observations)),
      source: "rpc",
      toolOrAgent: pick(...agents(effectiveEvent), effectiveEvent.toolName) || null,
      evidence: `rpc event #${index + 1}`,
      sequence: index,
    });
  }
  return issues;
}
function issueOrder(a, b) {
  const ta = Date.parse(a.occurredAt || "");
  const tb = Date.parse(b.occurredAt || "");
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  if (Number.isFinite(ta) !== Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : 1;
  const sa = REPORT_STAGE_ORDER.indexOf(a.stageId);
  const sb = REPORT_STAGE_ORDER.indexOf(b.stageId);
  return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb) || (a.sequence || 0) - (b.sequence || 0);
}
function uniqueAbsolute(values, base) {
  return [...new Set(values.flat().map((value) => absolute(value, base)).filter(Boolean))].sort();
}

/** Pure function: all filesystem values must already be parsed. */
export function analyzeHtmlReportRun(input) {
  const run = obj(input.run);
  const pipeline = obj(input.pipelineState);
  const checkpoints = arr(input.checkpoints).map(obj);
  const observations = [...arr(input.stageObservations), ...arr(run.stageObservations)].map(obj);
  const events = normalizedRpc(input.rpcEvents);
  const eventScopes = [...observations, ...pipelineEventScopes(pipeline, run)];
  const config = obj(input.performanceConfig);
  const base = resolve(pick(input.baseDir, run.runDir, process.cwd()));
  const paths = obj(input.paths);
  const transcriptData = mergedTranscriptData(
    subagentTranscriptBindings(events, eventScopes, base),
    input.subagentTranscriptData,
    base
  );
  const transcriptAudit = analyzeSubagentTranscripts(transcriptData);
  const piSessionPath = absolute(pick(paths.piSessionJsonl, run.sessionFile, run.piSessionFile), base);
  const piSessionAudit = analyzePiSessionRecords(
    input.piSessionRecords,
    piSessionPath,
    eventScopes,
    obj(input.piSessionObservation)
  );
  const stages = [];
  const issues = [];
  for (const id of REPORT_STAGE_ORDER) {
    const ledger = obj(obj(pipeline.stages)[id]);
    const checkpoint = checkpoints.find((value) => observedStage(value) === id) || {};
    const observation = observations.find((value) => observedStage(value) === id) || {};
    if (!Object.keys(ledger).length && !Object.keys(checkpoint).length && !Object.keys(observation).length) continue;
    const executionDurationMs = numeric(observation.executionDurationMs, checkpoint.executionDurationMs, ledger.executionDurationMs) ?? 0;
    const wallClockDurationMs = numeric(observation.wallClockDurationMs, checkpoint.wallClockDurationMs) ?? elapsed(pick(observation.startedAt, checkpoint.startedAt, ledger.startedAt), pick(observation.endedAt, observation.settledAt, checkpoint.endedAt, ledger.completedAt, ledger.failedAt)) ?? executionDurationMs;
    const budget = stageBudget(id, run, checkpoint, observation, config);
    const budgetStatus = budget.hardMs !== null && executionDurationMs > budget.hardMs ? "hard_exceeded" : budget.softMs !== null && executionDurationMs > budget.softMs ? "soft_exceeded" : "within_budget";
    const tool = stageTools(id, events, eventScopes);
    const transcriptSummaries = transcriptAudit.summaries.filter((summary) => summary.stageId === id);
    const subagentMap = new Map(tool.subagents.map((agent) => [agent.agent, { ...agent }]));
    for (const summary of transcriptSummaries) {
      const agent = subagentMap.get(summary.agent) || {
        agent: summary.agent, dispatches: 0, durationMs: 0, failures: 0,
      };
      agent.failures += summary.failureCount;
      if (summary.failureCount) agent.transcriptFailures = summary.failureCount;
      if (summary.retryCount) agent.transcriptRetries = summary.retryCount;
      subagentMap.set(summary.agent, agent);
    }
    const subagents = [...subagentMap.values()].sort((a, b) => a.agent.localeCompare(b.agent));
    const attempts = arr(ledger.attempts);
    const retries = events.filter((event, index) => stageForEvent(event, index, eventScopes) === id && RETRIES.has(event.type));
    const observedRetryCount = numeric(observation.retryCount, checkpoint.retryCount) ?? 0;
    const rpcRetryCount = Math.max(retries.length, observedRetryCount);
    const subagentRetryCount = transcriptSummaries.reduce((sum, value) => sum + value.retryCount, 0);
    const subagentMs = subagents.reduce((sum, value) => sum + value.durationMs, 0);
    const transcriptIndicatorsCliDurationMs = transcriptSummaries.reduce((sum, value) => sum + value.indicatorsCliDurationMs, 0);
    const transcriptDeterministicScriptDurationMs = transcriptSummaries.reduce((sum, value) => sum + value.deterministicScriptDurationMs, 0);
    const indicatorsCliDurationMs = tool.indicatorsCliDurationMs + transcriptIndicatorsCliDurationMs;
    const deterministicScriptDurationMs = tool.deterministicScriptDurationMs + transcriptDeterministicScriptDurationMs;
    const completionSignal = pick(observation.completionSignal, checkpoint.completionSignal);
    const extensionGateOverheadDurationMs = completionSignal === "custom_gate"
      ? Math.max(0, executionDurationMs - subagentMs)
      : 0;
    const parentModelDurationMs = Math.max(0, executionDurationMs - subagentMs - extensionGateOverheadDurationMs);
    const layout = layoutOf(checkpoint, observation);
    const status = String(pick(observation.status, checkpoint.status, ledger.status, "not_run")).toLowerCase();
    stages.push({
      id, status, attempt: numeric(observation.attempt, checkpoint.attempt, attempts.at(-1)?.number) ?? 1,
      executionDurationMs, wallClockDurationMs, budget: { ...budget, status: budgetStatus },
      subagents, tools: tool.tools,
      retry: {
        count: rpcRetryCount + Math.max(0, attempts.length - 1) + subagentRetryCount,
        rpcRetryCount,
        gateRetryCount: Math.max(0, attempts.length - 1),
        subagentRetryCount,
      },
      layout,
      indicatorsCliDurationMs,
      deterministicScriptDurationMs,
      transcriptIndicatorsCliDurationMs,
      transcriptDeterministicScriptDurationMs,
      extensionGateOverheadDurationMs,
      parentModelDurationMs,
      parentTailDurationMs: Math.max(0, parentModelDurationMs - tool.indicatorsCliDurationMs - tool.deterministicScriptDurationMs),
      subagentTranscript: {
        files: transcriptSummaries.flatMap((summary) => summary.paths),
        failures: transcriptSummaries.reduce((sum, value) => sum + value.failureCount, 0),
        retries: subagentRetryCount,
      },
    });
    issues.push(...explicitIssues(checkpoint, "checkpoint", id), ...explicitIssues(observation, "observation", id));
    if (status === "failed") {
      const reason = String(pick(ledger.failureReason, checkpoint.failureReason, observation.failureReason, `${id} Gate failed`));
      issues.push({ classification: classification(reason, "pipeline"), code: "GATE_FAILED", reason, occurredAt: asIso(ledger.failedAt, observation.endedAt, checkpoint.observedAt), stageId: id, source: "pipeline", toolOrAgent: null, evidence: input.paths?.pipelineState || null, sequence: 9000 });
    }
    if (layout.status === "fail") issues.push({ classification: "PRODUCT_CONTRACT", code: "LAYOUT_FAILED", reason: layout.reason || `${id} layout 检查失败`, occurredAt: asIso(observation.endedAt, checkpoint.observedAt), stageId: id, source: "checkpoint", toolOrAgent: "check-session-layout", evidence: null, sequence: 9001 });
    if (budgetStatus !== "within_budget") issues.push({ classification: "PERFORMANCE_REGRESSION", code: budgetStatus === "hard_exceeded" ? "HARD_BUDGET_EXCEEDED" : "SOFT_BUDGET_EXCEEDED", reason: `${id} 执行耗时 ${executionDurationMs}ms 超过${budgetStatus === "hard_exceeded" ? "硬" : "软"}预算 ${budgetStatus === "hard_exceeded" ? budget.hardMs : budget.softMs}ms`, occurredAt: asIso(observation.endedAt, checkpoint.observedAt, ledger.completedAt, ledger.failedAt), stageId: id, source: "performance", toolOrAgent: null, evidence: null, sequence: 9999 });
  }
  issues.push(
    ...rpcIssues(events, eventScopes),
    ...transcriptAudit.issues,
    ...piSessionAudit.issues,
    ...explicitIssues({ anomalies: arr(input.observationIssues) }, "observation-loader", stageId(run.stoppedStage)),
    ...explicitIssues(run, "run", stageId(run.stoppedStage))
  );
  issues.sort(issueOrder);
  const explicitFailure = ["fail", "failed", "error", "aborted"].includes(String(pick(run.status, run.result, "")).toLowerCase());
  let result = issues.some((issue) => issue.classification !== "PERFORMANCE_REGRESSION") || explicitFailure
    ? "FAIL" : issues.some((issue) => issue.classification === "PERFORMANCE_REGRESSION")
      ? "PERFORMANCE_REGRESSION" : pipeline.status === "completed" || String(run.status).toLowerCase() === "pass" ? "PASS" : "FAIL";
  if (result === "FAIL" && issues.length === 0) issues.push({ classification: "TEST_HARNESS", code: "INCOMPLETE_RUN", reason: "运行未完成且没有可识别的异常证据", occurredAt: asIso(run.endedAt, run.stoppedAt), stageId: stageId(run.stoppedStage), source: "run", toolOrAgent: null, evidence: null, sequence: 99999 });
  const artifacts = {
    runDir: absolute(pick(paths.runDir, run.runDir, base), base),
    runMetadata: absolute(pick(paths.runMetadata, paths.run, "run.json"), base),
    pipelineState: absolute(pick(paths.pipelineState, run.pipelineStatePath), base),
    checkpointsDir: absolute(pick(paths.checkpointsDir, run.checkpointsDir, "checkpoints"), base),
    rpcLog: absolute(pick(paths.rpcLog, run.rpcLogPath, "rpc.jsonl"), base),
    stderrLog: absolute(pick(paths.stderrLog, run.stderrLogPath, "stderr.log"), base),
    htmlReportSession: absolute(pick(paths.htmlReportSession, run.htmlReportSessionDir, pipeline.sessionDir), base),
    piSessionJsonl: piSessionPath,
    subagentTranscripts: uniqueAbsolute([
      ...arr(run.subagentTranscripts),
      ...REPORT_STAGE_ORDER.flatMap((id) => stageTools(id, events, eventScopes).transcripts),
      ...transcriptData.map((item) => item.path),
    ], base),
    subagentTranscriptBindings: transcriptData.map(({ path, stageId: parentStageId, agent }) => ({
      path, stageId: parentStageId, agent,
    })),
    performanceConfig: absolute(pick(paths.performanceConfig, run.performanceConfigPath), base),
    reportJson: absolute(pick(paths.reportJson, "self-test-report.json"), base),
    reportMarkdown: absolute(pick(paths.reportMarkdown, "self-test-report.md"), base),
  };
  return {
    version: 1, producer: PRODUCER,
    generatedAt: asIso(input.generatedAt, run.endedAt, run.stoppedAt, pipeline.observedAt) || new Date(0).toISOString(),
    result,
    session: {
      id: String(pick(run.sessionId, pipeline.sessionId, input.sessionId, "unknown")),
      startedAt: asIso(run.startedAt, pipeline.createdAt), endedAt: asIso(run.endedAt, run.stoppedAt, pipeline.observedAt),
      stoppedStage: stageId(pick(run.stoppedStage, pipeline.currentStage, stages.at(-1)?.id)),
      piVersion: pick(run.piVersion, obj(run.pi).version) || null,
      provider: pick(run.provider, obj(run.model).provider, obj(run.pi).provider) || null,
      model: pick(run.modelId, obj(run.model).id, obj(run.pi).model) || null,
      thinking: pick(run.thinking, run.thinkingLevel, obj(run.pi).thinking) || null,
    },
    source: {
      gitHead: pick(run.gitHead, obj(run.source).gitHead) || null,
      workspaceFingerprint: pick(run.workspaceFingerprint, obj(run.source).workspaceFingerprint) || null,
      originalPrompt: pick(run.originalPrompt, obj(run.prompt).original) || null,
      effectivePrompt: pick(run.effectivePrompt, obj(run.prompt).effective) || null,
    },
    stages,
    firstAnomaly: issues[0] || null,
    anomalies: issues,
    observations: {
      piSession: piSessionAudit.summary,
      subagentTranscripts: transcriptData.map((item) => ({
        path: item.path,
        stageId: item.stageId,
        agent: item.agent,
        status: item.observationStatus || (item.recordsProvided ? "provided" : "not_loaded"),
        recordCount: arr(item.records).length,
        error: item.observationError || null,
      })),
    },
    artifacts,
  };
}

const formatMs = (value) => Number.isFinite(value) ? value >= 1000 ? `${(value / 1000).toFixed(1)} 秒` : `${value} ms` : "—";
const cell = (value) => String(value ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
/** Pure Markdown renderer. */
export function renderHtmlReportRunMarkdown(report) {
  const session = obj(report.session);
  const source = obj(report.source);
  const lines = [
    "# html-report 自测报告", "", `结论：${report.result}`, `Session ID：${session.id || "—"}`,
    `停止阶段：${session.stoppedStage || "—"}`, `开始/结束时间：${session.startedAt || "—"} / ${session.endedAt || "—"}`,
    `Pi / Provider / Model / Thinking：${session.piVersion || "—"} / ${session.provider || "—"} / ${session.model || "—"} / ${session.thinking || "—"}`,
    `Git HEAD / 工作区指纹：${source.gitHead || "—"} / ${source.workspaceFingerprint || "—"}`,
    `固定 Prompt（原始）：${source.originalPrompt || "—"}`, `固定 Prompt（实际）：${source.effectivePrompt || "—"}`, "",
    "| 阶段 | 状态 | attempt | 执行耗时 / 墙钟 | 预算 | 子代理 | 工具 | 重试 | layout |",
    "| --- | --- | ---: | ---: | --- | --- | --- | ---: | --- |",
  ];
  for (const stage of arr(report.stages)) {
    const subagents = arr(stage.subagents).map((item) => `${item.agent}×${item.dispatches}/${formatMs(item.durationMs)}${item.failures ? `/失败${item.failures}` : ""}`).join("；") || "—";
    const tools = arr(stage.tools).map((item) => `${item.toolName}×${item.calls}/${formatMs(item.durationMs)}${item.failures ? `/失败${item.failures}` : ""}`).join("；") || "—";
    lines.push(`| ${cell(stage.id)} | ${cell(stage.status)} | ${stage.attempt} | ${formatMs(stage.executionDurationMs)} / ${formatMs(stage.wallClockDurationMs)} | ${cell(`${stage.budget.status}（软 ${formatMs(stage.budget.softMs)} / 硬 ${formatMs(stage.budget.hardMs)}）`)} | ${cell(subagents)} | ${cell(tools)} | ${stage.retry.count} | ${cell(`${stage.layout.status}${stage.layout.phase ? ` (${stage.layout.phase})` : ""}`)} |`);
  }
  lines.push("", "## 第一个异常", "");
  const issue = report.firstAnomaly;
  if (issue) lines.push(`- 分类：${issue.classification}`, `- 代码：${issue.code}`, `- 原因：${issue.reason}`, `- 发生时间：${issue.occurredAt || "—"}`, `- 阶段：${issue.stageId || "—"}`, `- 对应工具/子代理：${issue.toolOrAgent || "—"}`, `- 日志证据：${issue.evidence || "—"}`);
  else lines.push("未发现异常。");
  const transcriptIssues = arr(report.anomalies).filter((item) => item?.source === "subagent-transcript");
  if (transcriptIssues.length) {
    lines.push("", "## 子代理 transcript 异常", "");
    for (const item of transcriptIssues) {
      lines.push(`- ${item.stageId || "—"} / ${item.code} / ${item.toolOrAgent || "—"}：${item.reason}（${item.evidence || "—"}）`);
    }
  }
  lines.push("", "## 阶段耗时拆分", "");
  for (const stage of arr(report.stages)) {
    lines.push(`- ${stage.id}：父模型区间 ${formatMs(stage.parentModelDurationMs)}；Extension/Gate 开销 ${formatMs(stage.extensionGateOverheadDurationMs)}；子代理 ${formatMs(arr(stage.subagents).reduce((sum, item) => sum + item.durationMs, 0))}；Indicators CLI ${formatMs(stage.indicatorsCliDurationMs)}（其中子代理内 ${formatMs(stage.transcriptIndicatorsCliDurationMs)}）；固定脚本 ${formatMs(stage.deterministicScriptDurationMs)}（其中子代理内 ${formatMs(stage.transcriptDeterministicScriptDurationMs)}）；父代理收尾估算 ${formatMs(stage.parentTailDurationMs)}`);
  }
  lines.push("", "## JSONL 观测源", "");
  const observations = obj(report.observations);
  const piSession = obj(observations.piSession);
  lines.push(`- Pi Session：${piSession.status || "not_loaded"}；记录 ${piSession.recordCount || 0}；消息 ${piSession.messageCount || 0}；工具调用 ${piSession.toolCallCount || 0}；Assistant 失败 ${piSession.assistantFailureCount || 0}；${piSession.path || "—"}`);
  for (const transcript of arr(observations.subagentTranscripts)) {
    lines.push(`- 子代理 transcript：${transcript.status || "not_loaded"}；${transcript.stageId || "—"} / ${transcript.agent || "—"}；记录 ${transcript.recordCount || 0}；${transcript.path || "—"}${transcript.error ? `；错误 ${transcript.error}` : ""}`);
  }
  lines.push("", "## 产物路径", "");
  const artifacts = obj(report.artifacts);
  for (const [label, path] of [["自测运行目录", artifacts.runDir], ["html-report Session", artifacts.htmlReportSession], ["Pi Session JSONL", artifacts.piSessionJsonl], ["完整 RPC 日志", artifacts.rpcLog], ["Pipeline State", artifacts.pipelineState], ["Checkpoints", artifacts.checkpointsDir], ["stderr", artifacts.stderrLog], ["性能配置", artifacts.performanceConfig], ["机器报告", artifacts.reportJson], ["Markdown 报告", artifacts.reportMarkdown]]) lines.push(`- ${label}：${path || "—"}`);
  for (const path of arr(artifacts.subagentTranscripts)) lines.push(`- 子代理 transcript：${path}`);
  return `${lines.join("\n")}\n`;
}

async function json(path, optional = false) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (optional && error?.code === "ENOENT") return null; throw new Error(`无法读取 JSON ${path}：${error.message || error}`); }
}
async function jsonl(path) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`无法解析 ${path}:${index + 1}：${error.message || error}`); }
  });
}
async function observedJsonl(path) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    return {
      status: error?.code === "ENOENT" ? "missing" : "unreadable",
      records: [],
      error: error?.code === "ENOENT" ? `文件不存在：${path}` : `无法读取 ${path}：${error.message || error}`,
    };
  }
  const records = [];
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    try { records.push(JSON.parse(line)); }
    catch (error) {
      return {
        status: "invalid",
        records,
        error: `无法解析 ${path}:${index + 1}：${error.message || error}`,
      };
    }
  }
  return { status: "loaded", records, error: null };
}
/** Load child transcript JSONL files discovered from parent SubAgent results, then run the pure analyzer. */
export async function analyzeHtmlReportRunWithTranscripts(input) {
  const run = obj(input.run);
  const pipeline = obj(input.pipelineState);
  const observations = [...arr(input.stageObservations), ...arr(run.stageObservations)].map(obj);
  const events = normalizedRpc(input.rpcEvents);
  const eventScopes = [...observations, ...pipelineEventScopes(pipeline, run)];
  const base = resolve(pick(input.baseDir, run.runDir, process.cwd()));
  const bindings = mergedTranscriptData(
    subagentTranscriptBindings(events, eventScopes, base),
    input.subagentTranscriptData,
    base
  );
  const observationIssues = [...arr(input.observationIssues)];
  const subagentTranscriptData = await Promise.all(bindings.map(async (binding) => {
    const observation = binding.recordsProvided
      ? { status: "provided", records: binding.records, error: null }
      : await observedJsonl(binding.path);
    if (!["loaded", "provided"].includes(observation.status)) {
      observationIssues.push({
        classification: "TEST_HARNESS",
        code: "SUBAGENT_TRANSCRIPT_UNREADABLE",
        reason: observation.error,
        stageId: binding.stageId,
        toolOrAgent: binding.agent,
        evidence: binding.path,
      });
    }
    return {
      ...binding,
      records: observation.records,
      recordsProvided: true,
      observationStatus: observation.status,
      observationError: observation.error,
    };
  }));
  const paths = obj(input.paths);
  const piSessionPath = absolute(pick(paths.piSessionJsonl, run.sessionFile, run.piSessionFile), base);
  let piSessionRecords = input.piSessionRecords;
  let piSessionObservation = obj(input.piSessionObservation);
  if (piSessionPath && !Array.isArray(piSessionRecords)) {
    const observation = await observedJsonl(piSessionPath);
    piSessionRecords = observation.records;
    piSessionObservation = { path: piSessionPath, status: observation.status, error: observation.error };
    if (observation.status !== "loaded") {
      observationIssues.push({
        classification: "TEST_HARNESS",
        code: "PI_SESSION_JSONL_UNREADABLE",
        reason: observation.error,
        stageId: stageId(pick(run.stoppedStage, pipeline.currentStage)),
        toolOrAgent: "parent-assistant",
        evidence: piSessionPath,
      });
    }
  } else if (piSessionPath && Array.isArray(piSessionRecords) && !piSessionObservation.status) {
    piSessionObservation = { path: piSessionPath, status: "provided", error: null };
  }
  return analyzeHtmlReportRun({
    ...input,
    subagentTranscriptData,
    piSessionRecords,
    piSessionObservation,
    observationIssues,
  });
}
async function checkpointFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(directory, entry.name)).sort().map((path) => json(path)));
}
export async function analyzeHtmlReportRunDirectory(runDir, overrides = {}) {
  const base = resolve(runDir);
  const runPath = resolve(overrides.runMetadata || join(base, "run.json"));
  const run = await json(runPath);
  const projectRoot = absolute(pick(run.projectRoot, run.cwd), base);
  const pipelinePath = resolve(overrides.pipelineState || run.pipelineStatePath || (projectRoot && run.sessionId ? join(projectRoot, ".harness", "state", "html-report", run.sessionId, "debug", "pipeline-state.json") : join(base, "pipeline-state.json")));
  const rpcPath = resolve(overrides.rpcLog || run.rpcLogPath || join(base, "rpc.jsonl"));
  const checkpointsDir = resolve(overrides.checkpointsDir || run.checkpointsDir || join(base, "checkpoints"));
  const observationsPath = resolve(overrides.stageObservations || run.stageObservationsPath || join(base, "stage-observations.json"));
  const configPath = resolve(overrides.performanceConfig || run.performanceConfigPath || DEFAULT_PERFORMANCE_CONFIG_PATH);
  const reportJson = resolve(overrides.reportJson || join(base, "self-test-report.json"));
  const reportMarkdown = resolve(overrides.reportMarkdown || join(base, "self-test-report.md"));
  const [pipelineState, rpcEvents, checkpoints, observationsDoc, performanceConfig] = await Promise.all([json(pipelinePath), jsonl(rpcPath), checkpointFiles(checkpointsDir), json(observationsPath, true), json(configPath)]);
  return analyzeHtmlReportRunWithTranscripts({ run, pipelineState, rpcEvents, checkpoints, stageObservations: Array.isArray(observationsDoc) ? observationsDoc : arr(observationsDoc?.stages), performanceConfig, baseDir: base, generatedAt: overrides.generatedAt, paths: { runDir: base, runMetadata: runPath, pipelineState: pipelinePath, rpcLog: rpcPath, checkpointsDir, stderrLog: join(base, "stderr.log"), performanceConfig: configPath, htmlReportSession: run.htmlReportSessionDir, piSessionJsonl: run.sessionFile, reportJson, reportMarkdown } });
}
export async function writeHtmlReportRunReport(report) {
  const jsonPath = report.artifacts?.reportJson;
  const markdownPath = report.artifacts?.reportMarkdown;
  if (!isAbsolute(jsonPath || "") || !isAbsolute(markdownPath || "")) throw new Error("报告路径必须是绝对路径");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderHtmlReportRunMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}
function argumentsOf(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") return { help: true };
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key} 缺少参数值`);
    const map = { "--run-dir": "runDir", "--run": "runMetadata", "--pipeline-state": "pipelineState", "--rpc": "rpcLog", "--checkpoints": "checkpointsDir", "--stage-observations": "stageObservations", "--config": "performanceConfig", "--report-json": "reportJson", "--report-md": "reportMarkdown" };
    if (!map[key]) throw new Error(`未知参数 ${key}`);
    options[map[key]] = value;
  }
  if (!options.runDir) throw new Error("缺少 --run-dir");
  return options;
}
const usage = () => `用法：node ${basename(fileURLToPath(import.meta.url))} --run-dir <path> [--config <path>]\n`;
async function main() {
  try {
    const options = argumentsOf(process.argv.slice(2));
    if (options.help) return void process.stdout.write(usage());
    const report = await analyzeHtmlReportRunDirectory(options.runDir, options);
    const paths = await writeHtmlReportRunReport(report);
    process.stdout.write(`结果：${report.result}\n停止阶段：${report.session.stoppedStage || "—"}\nSession ID：${report.session.id}\n原因：${report.firstAnomaly?.reason || "无"}\n报告：${paths.markdownPath}\n`);
    if (report.result !== "PASS") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`analyze-html-report-run: ${error.message || error}\n${usage()}`);
    process.exitCode = 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
