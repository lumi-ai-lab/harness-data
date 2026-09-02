import { loadRuntime } from "./kernel-loader.mjs";

const runtime = await loadRuntime("local-bridge.mjs");

export const LOCAL_BRIDGE_STATES = runtime.LOCAL_BRIDGE_STATES;
export const LocalBridge = runtime.LocalBridge;
export const createLocalBridge = runtime.createLocalBridge;
