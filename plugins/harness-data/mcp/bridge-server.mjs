import { LocalBridge } from "./local-bridge.mjs";
import { dispatchMcpRequest } from "./server.mjs";

/**
 * Start a local HTTP transport for the exact same MCP dispatcher used by the
 * stdio server. The caller owns the returned bridge and must call stop().
 */
export function createMcpBridge(options = {}) {
  return new LocalBridge({
    ...options,
    handler: options.handler || (async (request) => dispatchMcpRequest(request)),
  });
}

export async function startMcpBridge(options = {}) {
  const bridge = createMcpBridge(options);
  await bridge.start();
  return bridge;
}
