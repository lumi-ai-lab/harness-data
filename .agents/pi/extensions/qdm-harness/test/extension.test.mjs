import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import extension from "../index.ts";

test("registers context and posttool handlers without authorization hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "qdm-harness-pi-"));
  mkdirSync(join(root, ".agents"), { recursive: true });
  mkdirSync(join(root, "wikis"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "data-harness-cli"), "");

  const handlers = new Map();
  extension({
    cwd: root,
    on(event, handler) {
      handlers.set(event, handler);
    },
  });

  assert.deepEqual(
    [...handlers.keys()].sort(),
    ["before_agent_start", "context", "session_shutdown", "session_start", "tool_call"],
  );
});
