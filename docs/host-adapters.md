# Harness Data 宿主适配层

Harness Data 的报告业务仍只有一套 MCP contract。宿主适配层只负责把
当前会话映射为经过校验的 Root Context，并声明宿主能力。

## 共享接口

`@lumi-ai-lab/harness-runtime-node/host-context` 导出
`HostContextProvider`。它提供：

```text
resolveContext()
requireWorkspace()
getSessionId()
getCapabilities()
getSecretReference()
diagnostics()
```

`getCapabilities()` 返回的能力对象包含 `host`、`surface`、
`workspaceRoot`、`sessionId`、`canWriteWorkspace`、`canWriteData`、
`supportsLocalUi`、`supportsHooks`、`hasStableSessionId` 和
`supportsSecretReference`。诊断输出中的密钥引用只返回类型，不返回路径或
标识符；需要实际读取时由 `getSecretReference()` 提供给受信任的宿主层。

## Codex

`CodexHostAdapter` 是默认适配器。它只接受宿主显式传入的
`HARNESS_WORKSPACE_ROOT` 或 `CODEX_WORKSPACE_ROOT`；`PWD` 不再作为隐式
工作区来源。旧行为如确有需要，必须显式设置
`HARNESS_ALLOW_LEGACY_PWD=1`。项目是否可信和是否在 allowlist 内仍由
`workspace-policy.json` 二次校验。
若宿主能够提供独立的 trust 结果，可通过 `HARNESS_WORKSPACE_TRUSTED`
传入；显式的 `false` 会立即拒绝写入。

## ChatGPT Desktop Chat/Work

`ChatGPTDesktopAdapter` 通过 `surface: "chat"` 或 `surface: "work"`
区分两个界面，但复用同一套 runtime 和六个 `html_report_*` 工具。Desktop
不声明 Hooks 能力；上下文、授权和 workspace 校验都在 MCP/适配层完成。

优先使用本地 stdio。若宿主无法直接启动 stdio，可按需启动
`LocalBridge`：

```js
const adapter = new ChatGPTDesktopAdapter({ surface: "chat", env });
await adapter.startBridge({ handler });
adapter.bridgeStatus();
await adapter.stopBridge();
```

Bridge 只绑定 loopback，使用每实例随机 bearer token，并提供明确的
`start`、`stop`、`status` 生命周期。它不扫描进程名，也不把业务数据发送
到公共云服务。`/health` 仅返回状态；`/mcp` 和 `/rpc` 必须带 token。

## 验收重点

- 缺少 workspace、未信任项目或不在 allowlist 时，所有写入型报告操作均
  fail closed；
- pluginRoot、dataRoot、secretRoot 和 workspaceRoot 经过 realpath 和
  关系校验；
- `main.md`/`main.html` 仍由共享 MCP 流程原子写入 workspace；
- Chat/Work 不依赖 `UserPromptSubmit`、`PreToolUse` 或 `PostToolUse`。
