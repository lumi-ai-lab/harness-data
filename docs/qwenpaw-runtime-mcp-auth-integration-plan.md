# QwenPaw runtime MCP 授权接入详细开发方案

> 文档状态：开发方案（本轮仅整理方案，不修改插件代码）  
> 适用分支：`feat/qwenpaw-runtime-mcp`  
> 目标工作区：`D:\Repos\harness-data-qwenpaw-runtime-mcp`  
> 最后更新：2026-09-04

## 1. 目标与范围

本方案把 QwenPaw agent 获取 QDM 授权 Blob 的来源，从本地
`channel-auth.json` 切换为 qdm-auth-center 提供的 runtime MCP。QwenPaw
仍接收同样的 `channel + user_id` 身份，仍把完整 `qdm1enc.*` Blob 交给现有
授权预检和 `qdm-metric-cli`，因此查询行为和下游协议不变。

本次改造只覆盖：

* `.agents/qwenpaw` 中的授权 Provider、配置读取和相关测试；
* QwenPaw 专属的 `qwenpaw setup`、`doctor`、安装/更新说明；
* QwenPaw runtime MCP 客户端的日志、超时、错误和敏感信息处理。

明确不在范围内：

* 不修改其他 agent 的授权实现和调用链；
* 不修改 qdm-auth-center 的 runtime MCP、SQLite 模型或 IAM 同步逻辑；
* 不把 MCP 接入 qdm-metric-cli，也不改变 authz-hook 的 scope 预检规则；
* 不在本轮删除旧的 `channel-auth.json` 代码，保留可控回滚和旧安装兼容入口；
* 不实现跨请求 Blob 缓存、身份映射、权限模型扩展或反向代理。

## 2. 已确认的前提

qdm-auth-center runtime MCP 已提供 Streamable HTTP endpoint，例如：

```text
POST http://qdm-auth-center:8765/mcp
Authorization: Bearer <runtime-token>
```

runtime 工具名为 `qdm_auth_lookup_blob`，输入 `channel`、`user_id`，成功时
返回完整 Blob。qdm-auth-center 当前从 IAM 同步时将渠道固定为 `wecom`；
QwenPaw 不应擅自改写调用方传入的 channel。调用方传入非 `wecom` 时由服务
按正常未找到处理并 fail-closed。

runtime 响应的成功载荷约定如下（`content[0].text` 为兼容回退，
`structuredContent` 为首选）：

```json
{
  "ok": true,
  "channel": "wecom",
  "user_id": "caiyingying",
  "blob": "qdm1enc...."
}
```

服务端工具声明带有通用 object `outputSchema`，成功结果同时包含
`structuredContent` 和 JSON 文本；因此客户端必须兼容两种结果位置，但不能
因为文本回退存在就跳过结构校验。

## 3. 现状与目标架构

### 3.1 当前流程

```text
+------------------+
| QwenPaw Request  |
+--------+---------+
         |
         v
+-------------------------+
| qdm_identity.py         |
| resolve channel/user_id |
+------------+------------+
             |
             v
+-------------------------+
| ChannelAuthProvider     |
| read channel-auth.json  |
+------------+------------+
             |
             v
+-------------------------+
| qdm1enc Blob            |
+------------+------------+
             |
             v
+-------------------------+
| authz-hook preflight    |
| scope/filter validation  |
+------------+------------+
             |
             v
+-------------------------+
| qdm-metric-cli query    |
+-------------------------+
```

当前 `plugin.py::_build_components` 创建 `ChannelAuthProvider`，
`_trusted_components` 在一次请求内取得 Blob 并构造 `AuthorizationSnapshot`。
后续 hook、过滤器归一化、CLI 执行和错误映射均不依赖 Blob 的来源。

### 3.2 目标流程

```text
+------------------+
| QwenPaw Request  |
+--------+---------+
         |
         v
+-------------------------+
| qdm_identity.py         |
| resolve channel/user_id |
+------------+------------+
             |
             v
+----------------------------+
| RuntimeMcpAuthProvider     |
| qdm_auth_lookup_blob       |
+-------------+--------------+
              |
              | HTTPS/HTTP + Bearer token
              v
+----------------------------+
| qdm-auth-center runtime    |
| Streamable HTTP MCP :8765  |
+-------------+--------------+
              |
              v
+----------------------------+
| SQLite channel_credentials|
| (channel,user_id) -> Blob  |
+-------------+--------------+
              |
              v
+----------------------------+
| complete qdm1enc.* Blob    |
+-------------+--------------+
              |
              v
+----------------------------+
| AuthorizationSnapshot      |
| authz-hook preflight       |
+-------------+--------------+
              |
              v
+----------------------------+
| qdm-metric-cli query       |
+----------------------------+
```

身份解析和授权判定仍在插件内完成；MCP 只负责根据已解析身份取回完整
Blob，不接受查询过滤器、SQL、workspace 路径等其他业务参数。

## 4. MCP 客户端协议设计

### 4.1 连接与请求顺序

Provider 使用一个轻量 HTTP JSON-RPC 客户端，避免把额外 MCP SDK 引入
QwenPaw 插件包。每个 Provider 实例可在进程内复用已验证的初始化状态；服务
端为 stateless MCP，进程重启后重新初始化即可。

```text
首次调用或初始化状态失效
        |
        v
POST /mcp  method=initialize
        |
        +-- HTTP 非 2xx / JSON-RPC error --> fail-closed
        |
        v
POST /mcp  method=tools/call
           name=qdm_auth_lookup_blob
           arguments={channel,user_id}
        |
        +-- error/result.isError=true -----> fail-closed
        |
        v
解析 structuredContent，必要时解析 content[0].text
        |
        v
校验身份、ok 和 qdm1enc 前缀
        |
        +-- 任一校验失败 ------------------> fail-closed
        |
        v
返回 Blob 给现有 AuthorizationSnapshot
```

实现时应发送 JSON-RPC 2.0 请求，并设置：

* `Content-Type: application/json`；
* `Accept: application/json, text/event-stream`（服务端若返回单个 JSON，直接解析；
  若返回 SSE，只接受最终 JSON-RPC message，不把事件文本当作 Blob）；
* `Authorization: Bearer <token>`；
* 可选 `X-Request-ID`，使用现有请求 ID，便于服务端审计关联。

`initialize` 的 protocol version 使用客户端支持的版本（默认
`2025-03-26`），收到服务端协商版本后保存；不因版本字符串不同而相信
未经校验的结果。`notifications/initialized` 可发送也可省略，具体以
Streamable HTTP 客户端实现为准；不得把通知响应当作工具结果。

### 4.2 响应解析优先级

解析必须是“结构优先、文本兼容、内容一致”：

1. 读取 JSON-RPC `result`，存在 `error` 或 `result.isError == true` 立即失败；
2. 若存在 `result.structuredContent`，它必须是 JSON object，作为主载荷；
3. 若没有结构载荷，才解析 `result.content` 中第一个 `type=text` 的 JSON；
4. 两者同时存在时，文本回退必须能解析为 object，且 `ok/channel/user_id/blob`
   与结构载荷一致；不一致视为协议错误，不选择其中一个继续执行；
5. 禁止从普通文本中用正则提取 Blob，禁止接受未带 `qdm1enc.` 前缀的值。

### 4.3 载荷校验

以下条件全部满足才返回 Blob：

* `ok` 严格为布尔值 `true`；
* `channel`、`user_id` 为非空字符串，并与请求值逐字匹配（不做大小写折叠）；
* `blob` 为非空字符串，去除首尾空白后以 `qdm1enc.` 开头；
* Blob 长度不超过配置的响应上限（建议 1 MiB，需覆盖实际加密权限文件）；
* JSON 对象无重复关键字段，未发生类型宽松转换。

服务端返回 `USER_NOT_FOUND`、未授权、数据库不可用等均映射为插件现有的
`ChannelAuthorizationError`，上层继续使用既有通用错误码，不向 agent 暴露
底层原因。

### 4.4 超时、重试与连接复用

* 默认单次请求总超时 10 秒，可在 `runtime_mcp.timeout_seconds` 配置，范围
  1--60 秒；连接和读取超时均不得无限等待。
* 仅对连接失败、超时和 HTTP 502/503/504 做一次重试，退避 100--300 ms；
  不重试 400、401、403、404、JSON-RPC 业务错误或 Blob 校验错误。
* 重试仍失败立即 fail-closed；不在请求线程建立无界队列。
* 每次查询请求最多调用一次 lookup（重试属于同一次调用）；当前请求内继续
  复用 `AuthorizationSnapshot`，不做跨请求 Blob 缓存。
* 连接池可复用 TCP 连接，但必须隔离 endpoint 和 Authorization header，
  不得跨不同配置实例共享 token。

## 5. QwenPaw Provider 设计

### 5.1 接口保持不变

新增实现应保持现有抽象：

```python
class AuthProvider(Protocol):
    def blob_for(self, requester: Requester) -> str: ...
```

建议将现有 `ChannelAuthProvider` 改为可配置的 runtime MCP Provider，或新增
`RuntimeMcpAuthProvider` 并由配置选择。`plugin.py` 上层只依赖
`blob_for(requester)`，因此 `_trusted_components`、snapshot 和 CLI 不变。

Provider 内部职责：

1. 检查 `Requester.status == "resolved"`；
2. 读取并校验 token 文件（启动时做基本校验，调用时确保内容未变为空）；
3. 调用 initialize/tools/call；
4. 按第 4 节解析和校验响应；
5. 记录不含敏感值的诊断信息并抛出统一 `ChannelAuthorizationError`。

Provider 不负责：身份推断、权限 scope 判断、查询参数清洗、CLI 调用、Blob
解密或 Blob 内容打印。

### 5.2 组件装配

```text
load_config()
    |
    +-- runtime_mcp.enabled == true
    |       -> RuntimeMcpAuthProvider(endpoint, token_file, limits)
    |
    +-- legacy/rollback mode
            -> ChannelAuthProvider(auth_file)

_trusted_components()
    |
    +-- requester resolved?
    +-- provider.blob_for(requester)
    +-- AuthorizationSnapshot(blob, scope, normalized filters)
    +-- existing authz-hook + qdm-metric-cli
```

默认生产模式应要求 runtime MCP 配置完整；未配置 endpoint 或 token_file
时不自动回退读取 `channel-auth.json`，以免部署看似成功但实际继续使用旧权限。
只有显式的回滚开关/旧 schema 才允许旧 Provider。

## 6. 配置模型与密钥管理

### 6.1 Schema 2 扩展

在现有 `plugin-config.json` schema 2 中增加 `runtime_mcp` 对象；未知字段继续
拒绝，防止拼写错误被静默忽略：

```json
{
  "schema_version": 2,
  "plugin_id": "qdm-harness-qwenpaw",
  "root_context_path": "/var/lib/qdm/qwenpaw/instance/context.json",
  "secret_ref": "/run/secrets",
  "enabled_agents": ["harness-data-*"],
  "user_id_display_mode": "off",
  "tool_policy": "preserve",
  "runtime_mcp": {
    "enabled": true,
    "endpoint": "http://qdm-auth-center:8765/mcp",
    "token_file": "/run/secrets/qdm-auth-runtime.token",
    "timeout_seconds": 10,
    "max_response_bytes": 1048576
  }
}
```

字段规则：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `enabled` | 是 | 生产模式必须为 `true`；回滚配置可为 `false` |
| `endpoint` | 是 | 绝对 `http`/`https` URL，仅允许 `/mcp` 路径；禁止 query 中放 token |
| `token_file` | 是 | 绝对路径、regular file、非符号链接；Unix 权限 `0600` |
| `timeout_seconds` | 否 | 默认 10，范围 1--60 |
| `max_response_bytes` | 否 | 默认 1 MiB，范围 4 KiB--8 MiB |

生产环境优先使用 HTTPS。若 QwenPaw 与 qdm-auth-center 位于同一受限容器
网络，可使用 HTTP，但必须通过 Docker network/防火墙限制可达范围，并在
doctor 输出中明确显示 `transport=http-internal`。

### 6.2 Token 文件

Token 由部署系统写入独立 secret 文件，例如
`/run/secrets/qdm-auth-runtime.token`；普通 plugin 配置只保存路径，不保存
Token 内容。读取规则：

* 文件必须是 regular、非 symlink，大小在 1--4096 字节；读取后 trim，空值拒绝；
* Unix 检查 owner/权限，建议 `0600`；Windows 检查 ACL 仅允许运行账户读取；
* token 不出现在日志、异常文本、doctor JSON、进程命令行或测试快照；
* token 文件变化可在下一次调用重新读取，若读取失败直接 fail-closed；
* 轮换时先原子替换文件，再更新服务端 token，避免写入半截内容。

`session-hmac.secret`、qdm-metric-cli 所需其他密钥保持现有管理方式，不能
用 runtime MCP token 复用或替代。

### 6.3 Setup / update / doctor

```text
qwenpaw setup
    |
    +-- 解析 --runtime-mcp-endpoint / 配置文件
    +-- 解析 --runtime-mcp-token-file
    +-- 校验 URL、token 文件、权限和大小
    +-- 写 schema 2 plugin-config.json（仅写 token_file）
    +-- 安装/刷新 QwenPaw plugin
    +-- 运行最小 MCP connectivity check
    +-- 成功才报告 setup OK

qwenpaw doctor
    |
    +-- 配置存在性/格式检查
    +-- token 文件元数据检查（不输出内容）
    +-- GET/HEAD healthz（如部署允许）
    +-- 可选 initialize + tools/list（不调用真实用户 lookup）
    +-- 输出 endpoint、延迟、工具名、协议版本
```

doctor 默认不调用 `qdm_auth_lookup_blob`，避免把真实 Blob 写入诊断输出；
可提供显式的 `--check-user-id` 测试参数，但结果只返回 `found=true/false`、
耗时和错误码哈希，不返回 Blob。

setup 的 CLI 参数建议：

```text
--runtime-mcp-endpoint <url>
--runtime-mcp-token-file <path>
--runtime-mcp-timeout-seconds <n>
--runtime-mcp-max-response-bytes <n>
--runtime-mcp-disabled       # 仅用于显式回滚/离线开发
```

参数优先级沿用现有约定：显式 CLI > 配置文件 > 默认值。生产 setup 不应再
要求 `--auth-blob-file` 或 `--auth-user-id` 才能启用 QwenPaw runtime MCP。

## 7. 错误处理与可观测性

### 7.1 失败闭锁流程

```text
MCP lookup
   |
   +-- DNS/连接/超时/响应过大 --------------------+
   |                                               |
   +-- HTTP 401/403 或 JSON-RPC error -------------+
   |                                               |
   +-- JSON 无效、缺 result、isError=true ----------+
   |                                               |
   +-- structured/text 缺失或两者不一致 ------------+
   |                                               |
   +-- ok 非 true、身份不匹配 -----------------------+
   |                                               |
   +-- Blob 为空或非 qdm1enc.* ---------------------+
                                                   v
                                   QDM_CHANNEL_AUTH_DENIED
                                   （不执行 authz-hook/CLI）

有效 Blob
   |
   v
现有 authz-hook scope 预检 -> CLI 查询 -> 既有错误映射
```

建议保留现有通用错误文案，例如“QDM 渠道授权不可用或被拒绝”，底层日志仅
记录分类码：`MCP_CONNECT_FAILED`、`MCP_UNAUTHORIZED`、`MCP_PROTOCOL_INVALID`、
`MCP_IDENTITY_MISMATCH`、`MCP_BLOB_INVALID`。不得将 URL 中的 token、完整
响应、Blob、请求参数中的敏感扩展字段写入日志。

日志建议字段：`request_id`、`agent_id`、`channel`、`user_id_hash`、endpoint
主机名、attempt、elapsed_ms、error_code。`user_id` 使用现有脱敏策略；如
channel 也被视为敏感，记录固定枚举或哈希。

### 7.2 监控指标

可选增加本地计数器/结构化日志，不改变业务响应：

* lookup 总次数、成功次数、失败分类；
* initialize 成功率；
* 首次调用延迟、重试次数、响应大小；
* token 文件读取失败和配置校验失败次数。

指标标签不得包含 user_id、Blob 或 token；建议限制 endpoint 仅保留主机名。

## 8. 与其他 agent 的边界

```text
QwenPaw agent  ------------------> Runtime MCP qdm_auth_lookup_blob
                                   （本方案改造）

其他 agent ----------------------> 原有授权 Provider/来源
                                   （完全不变）

qdm-auth-center admin MCP -------> IAM 同步、加密、SQLite 落库
                                   （本方案不改）
```

插件激活 scope 继续由 `enabled_agents` 控制。只有匹配 QwenPaw 目标 agent
的请求才创建授权组件；其他 agent 即使共用进程，也不能借用 QwenPaw 的
Provider 或 token。

## 9. 测试方案

### 9.1 单元测试

覆盖 `RuntimeMcpAuthProvider`：

* resolved/未 resolved requester；
* initialize 成功、协议错误、服务端拒绝；
* structuredContent 成功；仅文本回退成功；两者不一致失败；
* 缺字段、类型错误、channel/user_id 不匹配；
* 合法/非法 Blob 前缀、空白和超长响应；
* token 文件不存在、symlink、空文件、权限错误；
* timeout、连接失败和 502/503/504 的一次重试；401/403/业务错误不重试；
* 日志和异常中不包含 token、Blob 和完整 MCP 响应。

### 9.2 集成测试

使用本地 fake Streamable HTTP MCP server，验证真实 JSON-RPC 顺序：

```text
fake MCP
  initialize -> tools/list -> tools/call
                      |
                      v
             qdm_auth_lookup_blob
                      |
                      v
QwenPaw hook -> authz-hook -> fake qdm-metric-cli
```

断言：一次查询只产生一次逻辑 lookup；同一请求的后续阶段复用 snapshot；
MCP 失败时 CLI 不启动；成功时传给 authz-hook/CLI 的 Blob 与服务端完全一致。

### 9.3 Setup/Doctor 与回归测试

* schema 2 新旧配置解析、未知字段拒绝和显式回滚模式；
* Windows、Linux、Docker secret 文件路径和权限检查；
* endpoint http/https 校验、响应上限和超时边界；
* `qwenpaw setup` 生成配置不含 token 内容；`doctor --json` 不含 Blob；
* 其他 agent 的既有授权测试全部通过；
* 现有 `channel-auth.json` 旧安装/legacy install 测试不回归。

## 10. 部署、迁移与回滚

### 10.1 部署顺序

```text
1. qdm-auth-center runtime MCP readyz=200
          |
2. 创建 runtime token secret 文件（0600/ACL）
          |
3. 更新 QwenPaw plugin-config.json（runtime_mcp）
          |
4. 重载/重启 QwenPaw plugin
          |
5. doctor 检查 initialize + tools/list
          |
6. 用测试用户执行一次真实查询并核对审计 request_id
```

先部署服务端再切客户端，避免客户端切换后出现连续授权失败。运行时
SQLite 数据仍由 qdm-auth-center 管理，QwenPaw 不挂载其数据库文件。

### 10.2 `channel-auth.json` 边界

切换后：

* 新 schema 2 生产配置不再将 `channel-auth.json` 作为授权来源；
* setup 不复制、改写或自动导入该文件；
* 旧文件可暂时保留在 secret 目录，用于 legacy install 或紧急回滚；
* 文档、doctor 和日志不得暗示旧文件仍是生产主路径；
* 待 runtime MCP 稳定运行并完成观察窗口后，另行提出删除旧 Provider 的变更。

### 10.3 显式回滚

回滚必须是运维可见且可审计的操作：

1. 停止/重载 QwenPaw plugin；
2. 将配置切换到旧 schema/显式 `runtime_mcp.enabled=false`；
3. 确认 `auth_file` 指向受保护的旧 `channel-auth.json`；
4. `doctor` 检查旧 Provider 和文件权限；
5. 观察查询恢复后再定位 MCP 故障。

runtime MCP 失败时插件不能隐式回退旧文件，否则权限数据可能静默过期，
也无法判断当前查询使用了哪个授权源。

## 11. 分阶段实施步骤

### Phase 0：冻结契约

1. 固化 `qdm_auth_lookup_blob` 输入和成功响应字段；
2. 固化 `structuredContent`/文本双通道解析规则和错误分类；
3. 与 qdm-auth-center 联调健康检查、token 和 request-id 约定。

### Phase 1：Provider 与配置

1. 新增 MCP HTTP/JSON-RPC 客户端和 Provider；
2. 扩展 schema 2 的 `runtime_mcp` 校验与敏感文件检查；
3. 在组件装配中按模式选择 runtime Provider 或显式 legacy Provider；
4. 保持 `AuthorizationSnapshot`、authz-hook、CLI 代码不变。

### Phase 2：Setup、doctor、安装材料

1. 增加 setup 参数和配置写入；
2. doctor 增加 token/endpoint/initialize/tools-list 检查；
3. 更新 Linux/Docker 和 Windows 安装说明、secret 挂载示例；
4. 增加运行时故障排查和回滚文档。

### Phase 3：测试与灰度

1. 完成单元、fake MCP 集成和跨平台测试；
2. 在一个 QwenPaw agent 灰度，观察成功率、延迟和 MCP 审计；
3. 验证其他 agent 无行为变化；
4. 通过验收标准后再扩大范围。

### Phase 4：旧来源退场评估

观察窗口结束后单独评审：是否删除 `channel-auth.json` 默认路径、旧安装
参数和 legacy Provider。该阶段不应与首次切换绑定发布，便于快速回滚。

## 12. 验收标准

功能验收：

* QwenPaw 使用 `channel + user_id` 调用 runtime MCP，能够取得完整
  `qdm1enc.*` Blob 并完成现有查询；
* `AuthorizationSnapshot` 在同一请求内复用，CLI 参数和 authz-hook 行为与
  切换前一致；
* qdm-auth-center SQLite 中的 Blob 不被 QwenPaw 读取或复制。

安全与可靠性验收：

* token 仅存在 secret 文件，日志、配置回显、doctor 和异常均无 token/Blob；
* 超时、网络错误、未授权、协议错误、身份不匹配和非法 Blob 全部
  `QDM_CHANNEL_AUTH_DENIED`，且不会执行 CLI；
* 不存在隐式旧文件回退；回滚必须显式配置；
* Docker/Linux/Windows secret 文件检查符合平台要求；
* 响应大小、超时、重试次数均有上限。

兼容性验收：

* 其他 agent 的测试和运行行为不变；
* legacy `install`/旧 schema 在回滚窗口内仍可用；
* qwenpaw setup/doctor 输出能明确区分 runtime MCP 模式和 legacy 模式。

## 13. 提交记录规范

每个实现阶段单独提交，使用 Angular 风格标题，正文中文并说明影响范围，
例如：

```text
feat(qwenpaw): 接入 runtime MCP 授权 Blob Provider

- 新增 qdm_auth_lookup_blob JSON-RPC 客户端和响应校验
- 保持 AuthorizationSnapshot、authz-hook 与 qdm-metric-cli 调用链不变
- 失败统一映射为 QDM_CHANNEL_AUTH_DENIED，日志不记录敏感值
```

本方案文档本身如单独提交，建议：

```text
docs: 设计 QwenPaw runtime MCP 授权接入方案

- 记录 MCP 协议、配置、Token 管理和失败闭锁规则
- 明确仅改 QwenPaw，其他 agent 与 qdm-auth-center 服务端不变
- 补充测试、部署、灰度和显式回滚步骤
```

