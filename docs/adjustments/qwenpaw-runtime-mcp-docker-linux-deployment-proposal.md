# QwenPaw Runtime MCP Linux/Docker 部署调整方案

> 状态：评审建议已补充，待按本文实施。

## 1. 背景与结论

当前 runtime MCP 分支已完成以下能力：

- QwenPaw 插件通过 runtime MCP 查询用户 Blob；
- qdm-auth-center 提供 runtime MCP（默认 `8765`）和 admin MCP（默认 `8766`）；
- QwenPaw 插件不再需要在默认流程读取 `channel-auth.json`；
- runtime MCP Token 从文件读取，Blob 不写入日志。

但现有 QwenPaw Docker 部署仍按旧的 `channel-auth.json` 流程设计。代码合并到 `master` 后，如果只构建现有 Dockerfile，插件代码会进入镜像，但 runtime MCP 不会被真正启用。

必须同步调整 Dockerfile、启动脚本、Compose 网络和部署文档。

## 2. 当前部署缺口

### 2.1 QwenPaw 镜像配置缺口

`deploy/qwenpaw/Dockerfile` 当前执行 `harness-data qwenpaw setup` 时未传入：

- `--runtime-mcp-endpoint`；
- `--runtime-mcp-token-file`。

因此生成的 `plugin-config.json` 不包含有效的 `runtime_mcp` 配置。

### 2.2 启动脚本仍强制依赖旧文件

`deploy/qwenpaw/run_docker.sh` 当前强制检查并挂载：

```text
channel-auth.json
session-hmac.secret
```

调整后，`run_docker.sh` 作为 runtime MCP 主启动入口，应改为检查：

```text
qdm-auth-runtime.token
session-hmac.secret
```

原有 `channel-auth.json` 检查逻辑应迁移至 `deploy/qwenpaw/run_docker_rollback.sh`，该脚本只保留给显式 legacy/回滚模式。

### 2.3 qdm-auth-center 尚未纳入 QwenPaw 网络拓扑

QwenPaw 当前没有保证能够通过容器 DNS 访问：

```text
http://qdm-auth-center:8765/mcp
```

两个服务必须加入同一个 Docker network；如果使用两个 Compose 项目，需要使用外部共享 network。

### 2.4 构建阶段不能访问生产 MCP

Docker build 阶段 qdm-auth-center 通常尚未启动，不能执行真实 MCP 连通性检查；同时不能把生产 Token 写入镜像层。

## 3. 推荐目标架构

```text
                         Docker network
┌──────────────────────┐       ┌────────────────────────┐
│ qwenpaw              │       │ qdm-auth-center         │
│                      │       │                         │
│ plugin-config.json   │       │ HTTP API :4008          │
│ token: /run/secrets/ │──────▶│ runtime MCP :8765       │
│ qdm-auth-runtime.token│      │ admin MCP :8766         │
└──────────┬───────────┘       └────────────┬────────────┘
           │                                │
           │ read-only                      │ persistent
           ▼                                ▼
  runtime token + HMAC                 SQLite data volume
```

QwenPaw 请求链路：

```text
企微消息
  -> QwenPaw 身份解析(channel + user_id)
  -> runtime MCP initialize
  -> qdm_auth_lookup_blob
  -> 返回完整 qdm1enc Blob
  -> qdm-metric-cli 执行查询
```

不需要反向代理。runtime MCP 默认使用 Docker 内部网络；admin MCP 默认发布宿主机端口，供受控的运维端调用。若后续确有其他宿主机客户端需要访问 runtime MCP，必须另行明确防火墙来源范围、`allowed-hosts` 和 Token 分发边界，不能因为 QwenPaw 接入而默认发布 `8765`。

## 4. 必须调整的实现内容

### 4.1 QwenPaw Dockerfile

Dockerfile 必须支持以明确构建参数区分 `legacy` 与 `runtime-mcp` 两种镜像，
并为每种模式产出独立、固定的镜像标签。不得将原有 legacy 默认标签重建为
runtime MCP 配置。

建议增加受限的构建参数（仅允许 `legacy`、`runtime-mcp`），由 Dockerfile 在构建期
选择对应的 `qwenpaw setup` 参数；`build-docker-image.sh` 必须同时提供明确模式参数并
分别输出两类不可变标签。不得由环境变量隐式决定模式，也不得用同一可变标签覆盖 legacy
镜像。推荐标签约定：

```text
harness-data-qwenpaw:<version>-amd64
harness-data-qwenpaw:<version>-mcp-amd64
```

仅在构建 MCP 镜像时，为 `qwenpaw setup` 增加 runtime MCP 配置：

```text
--runtime-mcp-endpoint http://qdm-auth-center:8765/mcp
--runtime-mcp-token-file /run/secrets/qdm-auth-runtime.token
--skip-runtime-mcp-check
```

由于 setup 当前要求 Token 文件存在，MCP 镜像构建阶段可创建空的占位文件，仅用于通过路径校验；该文件不得包含真实 Token，并应在最终运行时由 `/run/secrets` 只读挂载覆盖。占位文件必须在 Dockerfile 切换为非 root 的 `qwenpaw` 用户之前创建，并设置为普通、非符号链接文件；当前 `/run/secrets` 是 root 创建的只读目录，不能在 setup 阶段由非 root 用户临时创建。legacy 镜像保持当前 `--channel-auth-only` 的配置生成方式。

更灵活的替代方案是在 entrypoint 启动时渲染 endpoint 配置，适用于 qdm-auth-center 不固定使用 `qdm-auth-center` 服务名的环境。

### 4.2 双脚本部署与回滚策略（调整后）

`deploy/qwenpaw/run_docker.sh` 调整为 runtime MCP 的唯一主启动入口。该脚本应：

```text
qdm-auth-runtime.token
session-hmac.secret
```

它应：

1. 要求 `qdm-auth-runtime.token` 存在；
2. 首次启动时生成 `session-hmac.secret`，已有文件不得覆盖；
3. 将 Token 和 HMAC 文件只读挂载到 `/run/secrets`；
4. 以容器运行 UID/GID 验证两个文件可读；
5. 增加 MCP endpoint 连通性检查，验证 HTTP、Bearer Token、`initialize` 和 `tools/list`；
6. 不要求或读取 `channel-auth.json`；
7. 将 QwenPaw 容器加入 qdm-auth-center 所在的共享 Docker network。

原有 legacy 启动逻辑调整为 `deploy/qwenpaw/run_docker_rollback.sh`。该脚本是唯一的 legacy 回滚入口，继续要求并使用 `channel-auth.json` 与 `session-hmac.secret`，使用固定 legacy 镜像，且不读取 runtime MCP Token 或加入 runtime MCP 启动前检查。

`run_docker.sh` 使用 `QDM_RUNTIME_SECRET_DIR` 作为 MCP 主启动的密钥目录变量；`run_docker_rollback.sh` 继续使用 `QDM_CHANNEL_SECRET_DIR`，避免 legacy 导出任务的环境变量和运维习惯变化。

`QDM_RUNTIME_SECRET_DIR` 应为仅存放 runtime Token 与 session HMAC 的专用宿主机目录，并整体只读挂载到 `/run/secrets`；避免将整个 qdm-auth-center 配置或数据目录暴露给 QwenPaw。若 qdm-auth-center 使用 Docker Secret 注入 Token，轮换后仍必须重建其容器；QwenPaw 不得假设 Docker Secret 文件会在运行中的容器内自动更新。

连通性检查必须以正式容器相同的运行 UID/GID、只读密钥挂载和共享 Docker network 执行，不能在宿主机直接探测后就视为通过。检查命令不得回显 Token、Blob 或 HTTP 请求正文；应使用一次性容器或启动前的等价探测过程，依次验证 `initialize` 与 `tools/list`，并在失败时阻止 QwenPaw 容器启动。

共享网络使用固定名称（例如 `qdm-auth-network`），由部署前置步骤显式创建并检查存在；qdm-auth-center Compose 与 QwenPaw runtime 脚本均加入该 external network，并为 qdm-auth-center 声明 `qdm-auth-center` 网络别名。这样 `runtime_mcp.endpoint` 中固定的容器 DNS 名称才具有可验证的含义。

#### 4.2.1 必须使用隔离的镜像标签

不能只新增 MCP 脚本而让新旧脚本使用同一张、已写入
`runtime_mcp.enabled=true` 的镜像。原因如下：

- `plugin-config.json` 位于镜像内 `/etc/qdm/qwenpaw/plugin-config.json`；
  使用 MCP 配置镜像时，即使旧脚本仍挂载 `channel-auth.json`，插件也会继续
  访问 runtime MCP；
- `entrypoint.sh` 每次容器启动都会用镜像中的插件产物覆盖持久卷内的插件目录，
  因此不能依赖工作卷中残留的旧插件代码完成回滚；
- 回滚必须同时恢复旧 Provider 配置和旧插件产物，而不仅是替换 secret 文件。

因此两套脚本必须使用固定、不同的镜像标签，例如：

| 模式 | 脚本 | 默认镜像 | 授权来源 |
| --- | --- | --- | --- |
| runtime MCP（主启动） | `run_docker.sh` | `harness-data-qwenpaw:<mcp-version>-mcp-amd64` | qdm-auth-center runtime MCP |
| legacy（仅回滚） | `run_docker_rollback.sh` | `harness-data-qwenpaw:<legacy-version>-amd64` | `channel-auth.json` |

MCP 镜像构建时写入 `runtime_mcp.enabled=true`；legacy 镜像保持
`runtime_mcp` 字段缺失或显式禁用。两个镜像可基于同一代码版本构建，但必须
以不同标签保留，不能用同一可变标签覆盖 legacy 镜像。

#### 4.2.2 持久卷与回滚边界

两套脚本可以共享原有 QwenPaw 命名卷、容器名和渠道配置。切换脚本时会删除并
重建同名容器，产生一次短暂渠道断连，但不得删除以下卷：

```text
qwenpaw-working
qwenpaw-secret
qwenpaw-backups
qdm-data
```

MCP 观察期内，仍必须保留并持续更新 legacy `channel-auth.json`。否则回滚脚本
即使仍可启动，也无法恢复用户授权查询。

发布方案必须同时定义 legacy 文件的维护责任：由指定的 qdm-auth-center 导出任务按既有
全量授权格式生成、原子替换 `channel-auth.json`，并在每次替换后保持 legacy 容器 UID/GID
可读。该任务的执行周期、输出路径、文件权限和最近一次成功时间都应纳入部署验收；仅保留
一个不会更新的历史文件不构成有效回滚能力。

MCP 异常时的回滚步骤为：

```text
1. 停止并删除当前 qwenpaw 容器（不删除命名卷）；
2. 确认 channel-auth.json 对 legacy 容器运行 UID/GID 可读；
3. 执行 deploy/qwenpaw/run_docker_rollback.sh；
4. 使用固定 legacy 镜像启动；
5. 验证企微/飞书请求重新通过 ChannelAuthProvider 获取 Blob。
```

#### 4.2.3 Runtime Token 轮换

QwenPaw 插件在每次查询时读取 Token 文件，而 qdm-auth-center 在启动时读取
`QDM_AUTH_RUNTIME_TOKEN_FILE`；当前服务不支持双 Token 并行校验。因此 Token 轮换必须是
受控发布操作，推荐步骤如下：

```text
1. 停止 QwenPaw runtime MCP 容器，避免新旧 Token 不一致期间产生 401；
2. 原子替换两端挂载的 runtime Token 文件，保持 0600/容器 UID 可读；
3. 重建或重启 qdm-auth-center，使其重新读取 Token；
4. 在共享网络内执行 initialize + tools/list 连通性检查；
5. 启动 QwenPaw runtime MCP 容器，并验证一次真实授权查询。
```

若未来需要无中断轮换，应由 qdm-auth-center 先实现双 Token 过渡能力；不能仅依赖替换文件。

### 4.3 QwenPaw Compose

现有 `deploy/qwenpaw/docker-compose.yml` 保持 legacy 行为和 `channel-auth.json` 挂载，
不得直接改为 runtime MCP 默认配置。runtime MCP 应新增独立的 Compose 文件（推荐
`docker-compose.runtime-mcp.yml`）或使用清晰、互斥的 Compose profile；无论采用哪种方式，
都必须避免 legacy 与 runtime MCP 变量、密钥目录或镜像标签混用。

需要增加或确认：

- QwenPaw 加入与 qdm-auth-center 相同的 Docker network；
- `/run/secrets/qdm-auth-runtime.token` 只读挂载；
- `/run/secrets/session-hmac.secret` 只读挂载；
- runtime MCP endpoint 使用容器服务名；
- 如 qdm-auth-center 与 QwenPaw 分属不同 Compose 项目，声明同一个 external network。

不建议将 runtime Token 通过普通环境变量传入 QwenPaw，避免出现在容器 inspect、进程环境或诊断输出中。

部署实现还必须同步更新 `.agents/qwenpaw/DOCKER-LINUX-VALIDATION.md` 与 `config/qwenpaw/README.md`：`run_docker.sh` 只检查 `qdm-auth-runtime.token` 与 `session-hmac.secret`；`run_docker_rollback.sh` 才检查 `channel-auth.json` 与 `session-hmac.secret`。

### 4.4 qdm-auth-center Compose

qdm-auth-center 应以以下模式启动：

```text
serve -config /app/config.yaml
```

并确认：

- runtime MCP 监听 `0.0.0.0:8765`；
- admin MCP 监听 `0.0.0.0:8766`；
- 使用 `QDM_AUTH_RUNTIME_TOKEN_FILE` 或 Docker Secret 注入 runtime Token；
- admin Token 单独配置；
- SQLite 使用持久化卷；
- 已有权限数据不会因容器重建丢失；
- `allowed-hosts` 包含实际 Docker 服务名。

QwenPaw 与 qdm-auth-center 必须使用同一份 runtime Token 内容，但各容器可以分别只读挂载。

qdm-auth-center Compose 必须显式加入前述 external network。端口发布策略如下：`8765` 仅供
Docker 内部网络访问，默认不发布宿主机端口；`8766` 默认发布宿主机端口以满足受控运维访问；
`4008` 是否发布由既有 HTTP API 的调用方决定。若运行环境要求将 `8765` 发布到宿主机，必须
在部署变量与防火墙规则中显式开启，并将该访问边界写入 `allowed-hosts` 和运维文档。

## 5. 容器构建与部署步骤

### 5.1 代码与测试

合并到 `master` 后执行：

```bash
go test ./...
```

并执行 QwenPaw 插件测试、插件产物校验和 Linux 构建校验。

### 5.2 准备 qdm-auth-center

1. 创建并检查共享 external Docker network；
2. 准备 `config.yaml`，其中 `allowed-hosts` 至少包含 `qdm-auth-center`；
3. 生成 runtime/admin MCP Token，并为 qdm-auth-center 配置 `QDM_AUTH_RUNTIME_TOKEN_FILE`；
4. 准备 SQLite 数据卷和 legacy `channel-auth.json` 的持续导出任务；
5. 构建并启动 qdm-auth-center 镜像，使其加入共享 network；
6. 验证 `/healthz`、MCP `initialize`、`tools/list` 和 `qdm_auth_lookup_blob`；验证必须使用容器网络内的服务名，而非仅使用宿主机回环地址。

### 5.3 构建 QwenPaw 镜像

1. 确认 `HARNESS_VERSION` 与已发布 Wiki 资源版本一致；
2. 确认 qdm-metric-cli 版本和平台资产可下载；
3. 以 `legacy` 模式构建并保留 legacy 镜像标签；该镜像不写入启用的 `runtime_mcp` 配置；
4. 以 `runtime-mcp` 模式构建独立 MCP 镜像，将 runtime MCP endpoint 和 Token 路径写入其插件配置；
5. MCP 构建使用 root 预创建的空占位 Token 文件并跳过构建阶段连通性检查；
6. 分别校验两张 QwenPaw 镜像中的 `plugin-config.json`：legacy 不启用 runtime MCP，MCP 镜像必须启用；
7. 不将真实 Token、Blob、`channel-auth.json` 或数据库文件复制进镜像。

### 5.4 启动 QwenPaw

1. 确认共享 Docker network 与 qdm-auth-center 已就绪；
2. 准备 runtime Token 和 session HMAC 文件，并确认 Token 与 qdm-auth-center 启动时读取的内容一致；
3. 以 `0600` 或等效 ACL 设置权限，并确认 UID/GID 可读；
4. 启动 qdm-auth-center；
5. 使用 `run_docker.sh` 启动 MCP QwenPaw；
6. 由 runtime 脚本在同一 network 内执行 MCP `initialize`、`tools/list` 启动前检查；
7. 执行 QwenPaw doctor 和 health check；
8. 确认 QwenPaw 容器能解析 `qdm-auth-center` 并访问 `8765/mcp`。

## 6. 验收项目

### qdm-auth-center

- `/healthz` 正常；
- runtime MCP Token 正确时 `initialize` 成功；
- `tools/list` 包含 `qdm_auth_lookup_blob`；
- 正确的 `channel + user_id` 能返回完整 Blob；
- 用户不存在、Token 错误、数据库异常均返回稳定错误。

### QwenPaw

- plugin-config 包含 `runtime_mcp.enabled=true`；
- Token 文件可读且不会出现在日志；
- 企微用户身份解析为 `wecom + user_id`；
- “查询我的数据权限”能完成 Blob 获取和 CLI 查询；
- qdm-auth-center 不可达时返回明确授权不可用提示；
- 旧 `channel-auth.json` 不存在时，runtime MCP 模式仍可工作；
- 未启用 runtime MCP 的 legacy 回滚模式仍可工作。
- runtime MCP 异常后，不删除命名卷即可通过 `run_docker_rollback.sh` 恢复
  legacy 授权链路。
- runtime Token 轮换按 4.2.3 步骤执行后，qdm-auth-center 与 QwenPaw 均使用新 Token，日志中不出现 Token；
- legacy `channel-auth.json` 导出任务在观察期内持续成功，且可由 legacy 容器运行 UID/GID 读取。

## 7. 兼容性与非目标

- 不修改 QwenPaw 正常 Agent、工具和渠道绑定逻辑；
- 不在镜像中保存任何生产密钥或用户 Blob；
- 不要求反向代理；
- 不将 runtime MCP Token 作为普通环境变量传入 QwenPaw；
- 不改变 admin MCP 的工具权限模型；
- 不删除 legacy `channel-auth.json` 代码、文件产出和 `run_docker_rollback.sh`，保留显式回滚能力；
- 不在 Docker build 阶段依赖运行中的 qdm-auth-center。

## 8. 建议提交说明

QwenPaw 部署调整建议拆分为独立提交，便于审查：

```text
feat(qwenpaw): enable runtime MCP auth in Linux Docker deployment
```

提交内容应明确包括：runtime MCP 配置写入、Token/HMAC secret 挂载、Docker network、启动前连通性检查和部署文档更新。
