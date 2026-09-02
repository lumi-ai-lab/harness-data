import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const LOCAL_BRIDGE_STATES = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
  FAILED: "failed",
});

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function tokenMatches(expected, supplied) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(supplied || ""));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body exceeds bridge limit");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new Error(`invalid JSON request: ${error?.message || error}`);
  }
}

/**
 * A deliberately small loopback bridge for Desktop Chat/Work.
 *
 * The bridge owns an explicit start/stop/status lifecycle and never scans for
 * processes or leaves orphan workers behind.  It accepts JSON-RPC-ish POSTs
 * on /mcp (and /rpc for local diagnostics) and forwards them to the injected
 * handler, so the six html-report MCP tools remain the single business API.
 */
export class LocalBridge {
  constructor({
    handler,
    provider = null,
    host = "127.0.0.1",
    port = 0,
    token = "",
    maxBodyBytes = 1024 * 1024,
    name = "harness-data",
  } = {}) {
    if (typeof handler !== "function") throw new TypeError("LocalBridge requires a request handler");
    if (!["127.0.0.1", "::1", "localhost"].includes(String(host))) {
      throw new Error("LocalBridge only accepts loopback hosts");
    }
    this.handler = handler;
    this.provider = provider;
    this.host = String(host);
    this.port = Number.isInteger(Number(port)) && Number(port) >= 0 ? Number(port) : 0;
    this.token = String(token || "") || randomBytes(32).toString("base64url");
    this.maxBodyBytes = Number.isInteger(Number(maxBodyBytes)) && Number(maxBodyBytes) > 0
      ? Number(maxBodyBytes)
      : 1024 * 1024;
    this.name = String(name || "harness-data");
    this.state = LOCAL_BRIDGE_STATES.IDLE;
    this.server = null;
    this.url = null;
    this.startedAt = null;
    this.stoppedAt = null;
    this.lastError = null;
  }

  async start() {
    if (this.state === LOCAL_BRIDGE_STATES.RUNNING) return this.status();
    if (this.state === LOCAL_BRIDGE_STATES.STARTING) return this._startPromise;
    this.state = LOCAL_BRIDGE_STATES.STARTING;
    this.lastError = null;
    this._startPromise = new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        this._handle(request, response).catch((error) => {
          this._send(response, 500, { ok: false, error: error?.message || String(error) });
        });
      });
      this.server = server;
      server.once("error", (error) => {
        this.state = LOCAL_BRIDGE_STATES.FAILED;
        this.lastError = asError(error);
        this.server = null;
        reject(error);
      });
      server.listen(this.port, this.host, () => {
        const address = server.address();
        const actualPort = typeof address === "object" && address ? address.port : this.port;
        this.port = actualPort;
        this.url = `http://${this.host === "::1" ? "[::1]" : this.host}:${actualPort}/mcp`;
        this.startedAt = new Date().toISOString();
        this.state = LOCAL_BRIDGE_STATES.RUNNING;
        resolve(this.status());
      });
    });
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async stop() {
    if (this.state === LOCAL_BRIDGE_STATES.STARTING && this._startPromise) {
      try {
        await this._startPromise;
      } catch {
        return this.status();
      }
    }
    if (!this.server && this.state === LOCAL_BRIDGE_STATES.FAILED) {
      this.state = LOCAL_BRIDGE_STATES.STOPPED;
      this.stoppedAt = new Date().toISOString();
      return this.status();
    }
    if (!this.server || [LOCAL_BRIDGE_STATES.IDLE, LOCAL_BRIDGE_STATES.STOPPED].includes(this.state)) {
      this.state = this.state === LOCAL_BRIDGE_STATES.IDLE ? LOCAL_BRIDGE_STATES.STOPPED : this.state;
      return this.status();
    }
    if (this.state === LOCAL_BRIDGE_STATES.STOPPING) return this._stopPromise;
    this.state = LOCAL_BRIDGE_STATES.STOPPING;
    this._stopPromise = new Promise((resolve) => {
      const server = this.server;
      server.close(() => {
        this.server = null;
        this.state = LOCAL_BRIDGE_STATES.STOPPED;
        this.stoppedAt = new Date().toISOString();
        this.url = null;
        resolve(this.status());
      });
    });
    try {
      return await this._stopPromise;
    } finally {
      this._stopPromise = null;
    }
  }

  status({ includeToken = false } = {}) {
    const result = {
      name: this.name,
      state: this.state,
      transport: "streamable-http",
      host: this.host,
      hostAdapter: this.provider?.host || null,
      surface: this.provider?.surface || null,
      port: this.port,
      url: this.url,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      error: this.lastError ? this.lastError.message : null,
    };
    if (includeToken) result.token = this.token;
    return result;
  }

  connectionInfo() {
    return {
      transport: "streamable-http",
      url: this.url,
      token: this.token,
      state: this.state,
    };
  }

  async _handle(request, response) {
    const originHost = this.host.includes(":") ? `[${this.host}]` : this.host;
    const requestUrl = new URL(request.url || "/", `http://${originHost}`);
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      this._send(response, 200, this.status());
      return;
    }
    if (request.method !== "POST" || !["/mcp", "/rpc"].includes(requestUrl.pathname)) {
      this._send(response, 404, { ok: false, error: "not found" });
      return;
    }
    const authorization = String(request.headers.authorization || "");
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const supplied = bearer || String(request.headers["x-harness-bridge-token"] || "");
    if (!tokenMatches(this.token, supplied)) {
      this._send(response, 401, { ok: false, error: "bridge authentication required" });
      return;
    }
    const payload = await readJsonBody(request, this.maxBodyBytes);
    let context = null;
    let contextError = null;
    if (this.provider?.resolveContext) {
      try {
        context = await this.provider.resolveContext();
      } catch (error) {
        contextError = error;
      }
    }
    const result = await this.handler(payload, {
      context,
      contextError,
      provider: this.provider,
      bridge: this,
    });
    if (result === null) {
      response.statusCode = 202;
      response.end();
      return;
    }
    this._send(response, 200, result === undefined ? { ok: true } : result);
  }

  _send(response, status, value) {
    if (response.headersSent) return;
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(`${JSON.stringify(value)}\n`);
  }
}

export function createLocalBridge(options = {}) {
  return new LocalBridge(options);
}
