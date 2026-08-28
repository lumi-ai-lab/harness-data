import assert from "node:assert/strict";
import test from "node:test";

import {
  injectAuthDescribeBlob,
  injectDataAuth,
  isMetricAuthzGatedCommand,
  rewriteGatedMetricCommands,
  SHELL_CMD,
  SHELL_POWERSHELL,
  stripAuthFlags,
} from "../src/lib/authz/metric-command.js";

test("metric command detection matches executable forms", () => {
  const commands = [
    "qdm-metric-cli analysis execute --metric saleAmt",
    "qdm-metric-cli.exe analysis execute --metric saleAmt",
    "./bin/qdm-metric-cli analysis execute --metric saleAmt",
    ".\\bin\\qdm-metric-cli.exe analysis execute --metric saleAmt",
    "$QDM_METRIC_CLI analysis execute --metric saleAmt",
    "${QDM_METRIC_CLI} auth describe",
    "FOO=bar /opt/qdm/bin/qdm-metric-cli auth describe",
    String.raw`C:\\harness\\bin\\qdm-metric-cli.exe auth describe`,
    "source config/qdm-cli-paths.env && qdm-metric-cli analysis execute --metric saleAmt",
  ];
  for (const command of commands) {
    assert.equal(isMetricAuthzGatedCommand(command), true, command);
  }
});

test("relative subdirectory detection requires exact metric CLI basename", () => {
  for (const command of [
    "./original/not-qdm-metric-cli.exe auth describe",
    "./original/qdm-metric-cli-helper.exe auth describe",
    "relative/qdm-metric-cli.exe.bak analysis execute --metric saleAmt",
  ]) {
    assert.equal(isMetricAuthzGatedCommand(command), false, command);
  }
});

test("injectDataAuth replaces relative subdirectory executable only", () => {
  const got = injectDataAuth(
    "./real/qdm-metric-cli.exe analysis execute --auth-blob qdm1enc.model --metric saleAmt",
    "qdm1enc.runtime",
    String.raw`D:\Harness Runtime\bin\qdm-metric-cli.exe`,
  );
  assert.ok(got.startsWith(`'D:\\Harness Runtime\\bin\\qdm-metric-cli.exe' analysis execute`));
  assert.equal(got.includes("./real/qdm-metric-cli.exe"), false);
  assert.equal(got.includes("qdm1enc.model"), false);
});

test("metric command detection ignores quoted text and heredoc", () => {
  for (const command of [
    `echo "qdm-metric-cli analysis execute"`,
    "cat <<EOF\nqdm-metric-cli auth describe\nEOF",
  ]) {
    assert.equal(isMetricAuthzGatedCommand(command), false, command);
  }
});

test("stripAuthFlags removes model supplied secrets", () => {
  const got = stripAuthFlags("qdm-metric-cli analysis execute --data-auth --auth-blob qdm1enc.model --metric saleAmt");
  assert.equal(got.includes("--auth-blob"), false);
  assert.equal(got.includes("--data-auth"), false);
  assert.equal(got.includes("qdm1enc.model"), false);
  assert.match(got, /--metric saleAmt/);
});

test("injectAuthDescribe adds only auth blob", () => {
  const got = injectAuthDescribeBlob("qdm-metric-cli auth describe", "qdm1enc.runtime", "/abs/qdm-metric-cli");
  assert.match(got, /auth describe --auth-blob 'qdm1enc.runtime'/);
  assert.equal(got.includes("--data-auth"), false);
});

test("injectDataAuth strips and replaces before pipe", () => {
  const got = injectDataAuth(
    "qdm-metric-cli analysis execute --metric saleAmt --auth-blob qdm1enc.model | jq .",
    "qdm1enc.runtime",
    "/abs/qdm-metric-cli",
  );
  assert.match(got, /--data-auth --auth-blob 'qdm1enc.runtime'/);
  assert.ok(got.includes("| jq ."));
  assert.equal(got.includes("qdm1enc.model"), false);
});

test("rewriteGatedMetricCommands renders CMD wrapper", { skip: process.platform !== "win32" }, () => {
  const got = rewriteGatedMetricCommands(
    `cmd /c "qdm-metric-cli.exe auth describe"`,
    "qdm1enc.runtime",
    String.raw`C:\bin\qdm-metric-cli.exe`,
    SHELL_CMD,
  );
  assert.match(got, /cmd \/c "/);
  assert.match(got, /auth describe/);
  assert.match(got, /qdm1enc.runtime/);
});

test("rewriteGatedMetricCommands renders PowerShell invocation", { skip: process.platform !== "win32" }, () => {
  const got = rewriteGatedMetricCommands(
    "qdm-metric-cli.exe analysis execute --metric saleAmt",
    "qdm1enc.runtime",
    String.raw`C:\bin\qdm-metric-cli.exe`,
    SHELL_POWERSHELL,
  );
  assert.match(got, /^& '/);
  assert.match(got, /--data-auth --auth-blob/);
});
