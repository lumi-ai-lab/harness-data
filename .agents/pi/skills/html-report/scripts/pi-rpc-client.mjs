import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const REQUEST_TIMEOUT_MS = 30_000;
const SETTLED_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 1_000;

export class PiRpcError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "PiRpcError";
    this.code = code;
    this.details = details;
  }
}

export class PiRpcResponseError extends PiRpcError {
  constructor(response) {
    super("RPC_RESPONSE_ERROR", String(response?.error || "Pi RPC command failed"), { response });
    this.name = "PiRpcResponseError";
    this.response = response;
  }
}

export function serializeJsonlRecord(value) {
  return `${JSON.stringify(value)}\n`;
}

/** LF is the only delimiter. Do not replace with Node readline. */
export function attachLfJsonlReader(stream, { onRecord, onError } = {}) {
  if (!stream?.on || typeof onRecord !== "function") {
    throw new PiRpcError("JSONL_READER_INVALID", "stream and onRecord are required");
  }
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let detached = false;
  const emit = (raw) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    try {
      onRecord(JSON.parse(line), line);
    } catch (cause) {
      onError?.(new PiRpcError(
        "INVALID_JSONL",
        `Pi RPC stdout contained invalid JSONL: ${cause.message}`,
        { line },
        { cause }
      ));
    }
  };
  const onData = (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      emit(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  };
  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) emit(buffer);
    buffer = "";
  };
  const onStreamError = (cause) => onError?.(new PiRpcError(
    "STDOUT_ERROR",
    `Pi RPC stdout failed: ${cause?.message || cause}`,
    {},
    { cause }
  ));
  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("error", onStreamError);
  return () => {
    if (detached) return;
    detached = true;
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("error", onStreamError);
  };
}

function timeout(value, fallback, name) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result <= 0) {
    throw new PiRpcError("INVALID_TIMEOUT", `${name} must be a positive number`);
  }
  return result;
}

function sessionId(value) {
  const result = String(value || "").trim();
  if (!result || /[\r\n\0]/.test(result)) {
    throw new PiRpcError("INVALID_SESSION_ID", "sessionId must be a non-empty single-line string");
  }
  return result;
}

function validateArgs(args) {
  const reserved = new Set([
    "--mode", "--approve", "--no-approve", "--session", "--session-id",
    "--session-dir", "--no-session", "--print", "-p",
  ]);
  for (const arg of args) {
    if (reserved.has(arg)) throw new PiRpcError("RESERVED_PI_ARG", `Pi RPC client owns ${arg}`);
  }
}

function data(response) {
  if (!response?.success) throw new PiRpcResponseError(response);
  return response.data;
}

export class PiRpcClient {
  constructor({
    cwd = process.cwd(),
    sessionId: requestedSessionId,
    piBin = "pi",
    env = {},
    args = [],
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    settledTimeoutMs = SETTLED_TIMEOUT_MS,
    spawnProcess = nodeSpawn,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
    onStderr,
  } = {}) {
    this.cwd = cwd;
    this.sessionId = sessionId(requestedSessionId);
    this.piBin = piBin;
    this.env = env;
    this.args = [...args];
    validateArgs(this.args);
    this.requestTimeoutMs = timeout(requestTimeoutMs, REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.settledTimeoutMs = timeout(settledTimeoutMs, SETTLED_TIMEOUT_MS, "settledTimeoutMs");
    this.spawnProcess = spawnProcess;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.onStderr = onStderr;
    this.child = null;
    this.pending = new Map();
    this.waiters = new Set();
    this.listeners = new Set();
    this.events = [];
    this.records = [];
    this.stderr = "";
    this.serial = 0;
    this.fatalError = null;
    this.detachStdout = null;
    this.detachProcess = null;
    this.exit = null;
    this.closing = false;
    this.closeResult = null;
  }

  get started() {
    return Boolean(this.child);
  }

  get running() {
    return Boolean(this.child) && !this.exit;
  }

  get processId() {
    const pid = Number(this.child?.pid);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }

  start() {
    if (this.child) throw new PiRpcError("ALREADY_STARTED", "Pi RPC client is already started");
    const args = ["--mode", "rpc", "--approve", "--session-id", this.sessionId, ...this.args];
    let child;
    try {
      child = this.spawnProcess(this.piBin, args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (cause) {
      throw new PiRpcError("SPAWN_FAILED", `Cannot start Pi RPC: ${cause.message}`, {}, { cause });
    }
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      throw new PiRpcError("INVALID_CHILD_PROCESS", "Pi process must expose stdin/stdout/stderr");
    }
    this.child = child;
    this.stderr = "";
    this.events = [];
    this.records = [];
    this.fatalError = null;
    this.exit = null;
    this.closing = false;
    this.closeResult = null;

    const onStderrData = (chunk) => {
      const text = chunk.toString();
      this.stderr += text;
      this.onStderr?.(text);
    };
    const onProcessError = (cause) => this.#fail(new PiRpcError(
      "PROCESS_ERROR", `Pi RPC process error: ${cause.message}. Stderr: ${this.stderr}`, {}, { cause }
    ));
    const onStdinError = (cause) => this.#fail(new PiRpcError(
      "STDIN_ERROR", `Pi RPC stdin error: ${cause.message}. Stderr: ${this.stderr}`, {}, { cause }
    ));
    const onExit = (code, signal) => {
      this.exit ||= { code, signal };
      const error = new PiRpcError(
        "PROCESS_EXIT",
        `Pi RPC process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`,
        { code, signal }
      );
      this.#rejectPending(error);
      this.#rejectWaiters(error);
    };
    child.stderr.on("data", onStderrData);
    child.on("error", onProcessError);
    child.stdin.on("error", onStdinError);
    child.on("exit", onExit);
    this.detachStdout = attachLfJsonlReader(child.stdout, {
      onRecord: (record) => this.#record(record),
      onError: (error) => this.#fail(error),
    });
    this.detachProcess = () => {
      child.stderr.off("data", onStderrData);
      child.off("error", onProcessError);
      child.stdin.off("error", onStdinError);
      child.off("exit", onExit);
    };
    return this;
  }

  onEvent(listener) {
    if (typeof listener !== "function") throw new PiRpcError("INVALID_LISTENER", "listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRecords() {
    return [...this.records];
  }

  getEvents() {
    return [...this.events];
  }

  getStderr() {
    return this.stderr;
  }

  request(command, { id, timeoutMs } = {}) {
    if (!command || typeof command !== "object" || Array.isArray(command) || !command.type) {
      return Promise.reject(new PiRpcError("INVALID_COMMAND", "command must be an object with type"));
    }
    const child = this.child;
    if (!child) return Promise.reject(new PiRpcError("NOT_STARTED", "Pi RPC client is not started"));
    if (this.closing) return Promise.reject(new PiRpcError("CLIENT_CLOSING", "Pi RPC client is closing"));
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.exit || child.exitCode !== null) {
      return Promise.reject(new PiRpcError("PROCESS_EXIT", "Pi RPC process has exited", this.exit || {}));
    }
    if (child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new PiRpcError("STDIN_NOT_WRITABLE", `Pi RPC stdin is not writable. Stderr: ${this.stderr}`));
    }
    const requestId = id === undefined ? `rpc-${++this.serial}` : String(id);
    if (!requestId || this.pending.has(requestId)) {
      return Promise.reject(new PiRpcError("DUPLICATE_REQUEST_ID", `request id is pending: ${requestId}`));
    }
    const waitMs = timeout(timeoutMs, this.requestTimeoutMs, "timeoutMs");
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(requestId);
        reject(new PiRpcError(
          "REQUEST_TIMEOUT",
          `Timeout waiting for ${command.type} after ${waitMs}ms. Stderr: ${this.stderr}`,
          { id: requestId, command: command.type, timeoutMs: waitMs }
        ));
      }, waitMs);
      this.pending.set(requestId, {
        command: command.type,
        resolve: (response) => {
          this.clearTimer(timer);
          if (response.success) resolve(response);
          else reject(new PiRpcResponseError(response));
        },
        reject: (error) => {
          this.clearTimer(timer);
          reject(error);
        },
      });
      try {
        child.stdin.write(serializeJsonlRecord({ ...command, id: requestId }), (error) => {
          if (!error) return;
          const pending = this.pending.get(requestId);
          this.pending.delete(requestId);
          pending?.reject(new PiRpcError("WRITE_FAILED", error.message, { id: requestId }, { cause: error }));
        });
      } catch (cause) {
        const pending = this.pending.get(requestId);
        this.pending.delete(requestId);
        pending?.reject(new PiRpcError("WRITE_FAILED", cause.message, { id: requestId }, { cause }));
      }
    });
  }

  async getState(options) {
    return data(await this.request({ type: "get_state" }, options));
  }

  async getCommands(options) {
    return data(await this.request({ type: "get_commands" }, options))?.commands || [];
  }

  prompt(message, options = {}) {
    const command = { type: "prompt", message: String(message) };
    if (options.streamingBehavior !== undefined) command.streamingBehavior = options.streamingBehavior;
    return this.request(command, options);
  }

  abort(options) {
    return this.request({ type: "abort" }, options);
  }

  abortRetry(options) {
    return this.request({ type: "abort_retry" }, options);
  }

  waitForAgentSettled({ timeoutMs = this.settledTimeoutMs } = {}) {
    return this.#waiter(timeoutMs, false).promise;
  }

  collectUntilAgentSettled({ timeoutMs = this.settledTimeoutMs } = {}) {
    return this.#waiter(timeoutMs, true).promise;
  }

  async promptAndWait(message, {
    requestId,
    requestTimeoutMs,
    settledTimeoutMs = this.settledTimeoutMs,
    streamingBehavior,
    completionPredicate,
    completionDescription,
  } = {}) {
    const waiter = this.#waiter(settledTimeoutMs, true, {
      completionPredicate,
      completionDescription,
    });
    try {
      const response = await this.prompt(message, {
        id: requestId,
        timeoutMs: requestTimeoutMs,
        streamingBehavior,
      });
      return { response, events: await waiter.promise };
    } catch (error) {
      waiter.cancel(error);
      throw error;
    }
  }

  async close({
    eofTimeoutMs = CLOSE_TIMEOUT_MS,
    termTimeoutMs = CLOSE_TIMEOUT_MS,
    killTimeoutMs = CLOSE_TIMEOUT_MS,
  } = {}) {
    if (!this.child) return this.closeResult || { phase: "not_started", exit: this.exit };
    if (this.closeResult) return this.closeResult;
    this.closing = true;
    const child = this.child;
    const eofMs = timeout(eofTimeoutMs, CLOSE_TIMEOUT_MS, "eofTimeoutMs");
    const termMs = timeout(termTimeoutMs, CLOSE_TIMEOUT_MS, "termTimeoutMs");
    const killMs = timeout(killTimeoutMs, CLOSE_TIMEOUT_MS, "killTimeoutMs");
    let phase = "eof";
    try {
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end();
    } catch {
      // Continue into signal escalation.
    }
    if (!(await this.#waitForExit(eofMs))) {
      phase = "sigterm";
      child.kill("SIGTERM");
      if (!(await this.#waitForExit(termMs))) {
        phase = "sigkill";
        child.kill("SIGKILL");
        if (!(await this.#waitForExit(killMs))) {
          const error = new PiRpcError("CLOSE_TIMEOUT", "Pi did not exit after EOF, SIGTERM, and SIGKILL");
          this.#finalize(error);
          throw error;
        }
      }
    }
    this.closeResult = { phase, exit: this.exit };
    this.#finalize();
    return this.closeResult;
  }

  #record(raw) {
    const receivedAtMs = Number(this.now());
    const record = { ...raw, receivedAt: new Date(receivedAtMs).toISOString(), receivedAtMs };
    this.records.push(record);
    if (record?.type === "response" && record.id !== undefined) {
      const id = String(record.id);
      const pending = this.pending.get(id);
      if (!pending) return this.#event(record);
      this.pending.delete(id);
      if (pending.command !== record.command) {
        pending.reject(new PiRpcError(
          "RESPONSE_COMMAND_MISMATCH",
          `response ${id} expected ${pending.command}, got ${record.command}`,
          { response: record }
        ));
      } else {
        pending.resolve(record);
      }
      return;
    }
    this.#event(record);
  }

  #event(event) {
    this.events.push(event);
    for (const listener of [...this.listeners]) listener(event);
    for (const waiter of [...this.waiters]) {
      if (waiter.collect) waiter.events.push(event);
      let completed = false;
      try {
        completed = waiter.completionPredicate(event) === true;
      } catch (cause) {
        this.waiters.delete(waiter);
        this.clearTimer(waiter.timer);
        waiter.reject(new PiRpcError(
          "COMPLETION_PREDICATE_FAILED",
          `Completion predicate failed: ${cause?.message || cause}`,
          { event },
          { cause }
        ));
        continue;
      }
      if (completed) {
        this.waiters.delete(waiter);
        this.clearTimer(waiter.timer);
        waiter.resolve(waiter.collect ? waiter.events : event);
      }
    }
  }

  #waiter(timeoutMs, collect, { completionPredicate, completionDescription } = {}) {
    if (!this.child) throw new PiRpcError("NOT_STARTED", "Pi RPC client is not started");
    if (this.fatalError) throw this.fatalError;
    const waitMs = timeout(timeoutMs, this.settledTimeoutMs, "settled timeoutMs");
    const customCompletion = completionPredicate !== undefined;
    const predicate = completionPredicate ?? ((event) => event?.type === "agent_settled");
    if (typeof predicate !== "function") {
      throw new PiRpcError("INVALID_COMPLETION_PREDICATE", "completionPredicate must be a function");
    }
    const description = String(
      completionDescription || (customCompletion ? "completion event" : "agent_settled")
    );
    let waiter;
    const promise = new Promise((resolve, reject) => {
      waiter = { collect, events: [], resolve, reject, timer: null, completionPredicate: predicate };
      waiter.timer = this.setTimer(() => {
        this.waiters.delete(waiter);
        reject(new PiRpcError(
          customCompletion ? "COMPLETION_EVENT_TIMEOUT" : "AGENT_SETTLED_TIMEOUT",
          `Timeout waiting for ${description} after ${waitMs}ms. Stderr: ${this.stderr}`,
          { timeoutMs: waitMs, events: [...waiter.events] }
        ));
      }, waitMs);
      this.waiters.add(waiter);
    });
    const cancel = (reason) => {
      if (!this.waiters.delete(waiter)) return;
      this.clearTimer(waiter.timer);
      waiter.reject(reason || new PiRpcError("WAIT_CANCELLED", "agent_settled wait cancelled"));
    };
    return { promise, cancel };
  }

  #fail(error) {
    this.fatalError ||= error;
    this.#rejectPending(this.fatalError);
    this.#rejectWaiters(this.fatalError);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  #rejectWaiters(error) {
    for (const waiter of this.waiters) {
      this.clearTimer(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  #waitForExit(waitMs) {
    if (this.exit || this.child?.exitCode !== null) return Promise.resolve(true);
    const child = this.child;
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        child?.off("exit", onExit);
        this.clearTimer(timer);
        resolve(result);
      };
      const onExit = () => finish(true);
      const timer = this.setTimer(() => finish(false), waitMs);
      child?.once("exit", onExit);
    });
  }

  #finalize(error) {
    this.detachStdout?.();
    this.detachProcess?.();
    this.detachStdout = null;
    this.detachProcess = null;
    const closed = error || new PiRpcError("CLIENT_CLOSED", "Pi RPC client closed");
    this.#rejectPending(closed);
    this.#rejectWaiters(closed);
    this.child = null;
  }
}
