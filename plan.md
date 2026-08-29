# Harness Data 全宿主插件化与双根架构实施方案

状态：In Progress
最近更新：2026-08-29
评审结论：批准“插件化 + 双根 + 通用核心/宿主适配层”方向；退回“插件目录作为可写产品根”的原方案。  
适用范围：Claude Code、Codex、WorkBuddy、Pi、QwenPaw、Hermes、OpenClaw。  
依据：当前分支代码、现有发布链路、测试结果，以及 handoff-plugin-first-directory-layout-2026-08-29.md 的调研内容。

## 0. 一页结论

本方案要解决的用户问题是：

- 用户安装并启用插件后，可以在任意项目目录打开 Agent；
- 不需要先在某个目录执行 install --dir，也不需要把仓库 clone 成产品 runtime；
- QDM wiki、CLI、html-report 和 authz 能作为一个产品能力使用；
- 报告进度按项目隔离；
- 插件升级、重装、宿主 cache 替换不会丢失用户数据和授权。

最重要的架构判断：

1. pluginRoot 与 workspaceRoot 必须分离。
2. pluginRoot 只能承载不可变代码、manifest、默认资源和只读 wiki/index。
3. auth、metric-cli、用户配置、session state、诊断日志不能默认写入 pluginRoot。
4. 必须引入宿主持久数据根 dataRoot，并为没有标准数据目录的宿主提供 OS 级 fallback。
5. workspaceRoot 必须由宿主显式传入或由已验证的 workspace handle 指定，不能继续依赖从插件 cache 或 PWD 猜测。
6. 普通 prompt 默认不自动召回 QDM wiki；显式 skill/command 是默认入口，自动召回只能作为 opt-in。
7. 旧 install --dir 必须保留一个迁移兼容窗口，迁移验证完成后才能删除。

如果产品坚持“完全不能有用户数据目录”，则必须缩小宿主支持范围：只能支持提供稳定持久数据 API 的宿主。不能同时承诺“七个宿主 + 插件目录可写 + 不需要 dataRoot”。

## 1. 当前问题与事实基线

### 1.1 当前代码的单根模型

当前 CLI 的 run() 先调用 findRoot()，再把同一个 root 传给 context、wiki、posttool、authz 和 show：

- packages/data-harness-cli/src/main.js:18
- packages/data-harness-cli/src/main.js:40

当前 findRoot() 会从起点向上搜索，并且仅发现 .harness 就可能认定为 Harness root：

- packages/data-harness-cli/src/lib/harness.js:42
- packages/data-harness-cli/src/lib/harness.js:56

当前知识、配置、CLI 路径和 state 都依赖同一个 root。UserPromptSubmit 还会写入完整 prompt 和计划状态：

- packages/data-harness-cli/src/lib/context/hook.js:73
- packages/data-harness-cli/src/lib/context/hook.js:167
- packages/data-harness-cli/src/lib/sessionstate.js:43

### 1.2 当前 runtime 与 CLI 的寻根规则不一致

runtime-node 识别 HARNESS_WORKSPACE_ROOT、CODEX_WORKSPACE_ROOT、PWD、父进程 cwd 和 process.cwd()：

- packages/harness-runtime-node/src/workspace-resolver.mjs:33

CLI 的 rootStart() 当前只识别 CODEBUDDY_PROJECT_DIR 和 CLAUDE_PROJECT_DIR：

- packages/data-harness-cli/src/main.js:18

双根改造必须统一这些规则，不能由每个宿主和每个 package 自己猜。

### 1.3 当前发布与安装链路并不支持目标形态

CI staging 会把 top-level plugins 放进 runtime 包：

- .github/workflows/publish-cli-release.yml:63

但安装器的 runtime 解包逻辑只复制 agents、bootstrap、packages/data-harness-cli 和 config，没有复制 top-level plugins：

- npm/src/commands/install.js:161

当前 wiki 仍作为独立 release zip 发布：

- .github/workflows/publish-cli-release.yml:109

当前插件 bundle 脚本只复制 kernel 和 runtime：

- plugins/qdm-html-report/scripts/bundle-dist.mjs:12

当前 index 的 metadata 会写入构建机绝对路径：

- packages/data-harness-cli/src/lib/wikis/index.js:90

因此“只搬目录”不会得到可发布、可升级、可重定位的插件。

### 1.4 当前验证基线

在本评审环境中已执行：

- npm installer：136 个测试全部通过；
- data-harness-cli：62 个通过，2 个跳过；
- harness-runtime-node：6 个通过；
- Pi packaging：测试运行器中的一个 build 用例失败，但直接执行 build + verify 可以通过。

这些测试没有覆盖目标双根模型、只读 pluginRoot、宿主升级替换、迁移和 secret transport，因此不能把当前绿灯当作新架构已经被验证。

## 2. 目标与非目标

### 2.1 目标

- 用户可以在任意项目目录使用已启用的 Agent 插件。
- 一个宿主对应一个用户可见的 qdm-harness 插件。
- 通用规则、wiki 解析、authz、CLI 调度和 html-report kernel 只实现一份。
- 每个宿主只保留 manifest、hook envelope、进程边界和宿主特有能力。
- 插件代码目录可被宿主替换或设为只读。
- auth、metric-cli、配置和状态有独立生命周期。
- state 按 workspace 和 session 隔离，并按需创建。
- 新插件可从旧 runtime 迁移，不丢失 auth、报告和 session。
- 每个宿主都有可重复执行的 clean-install、activation、reload/new-session 和 upgrade smoke test。

### 2.2 非目标

本阶段不做以下事情：

- 不改变 QDM wiki 的业务内容和解析规则；
- 不重写 html-report 的业务流程；
- 不把 Python 宿主改成 Node 宿主；
- 不要求一次性支持所有历史版本的旧 runtime；
- 不把 workspace-local state 作为团队协作数据库；
- 不在插件安装时自动修改用户项目业务文件；
- 不在没有安全传输方案前继续扩大 auth blob 的命令行暴露面。

## 3. 架构原则

### 3.1 生命周期分离

代码、默认资源、可执行文件、用户配置、密钥和项目产物的生命周期不同，不能共享一个“产品根”。

### 3.2 显式上下文优先于启发式寻根

插件运行时必须收到结构化的 root context。向上扫描只允许作为旧 runtime 迁移或兼容模式，不能作为新插件的默认协议。

### 3.3 只读插件、可写数据

宿主管理的 plugin cache、版本化插件目录和 seed 目录都必须按只读处理。所有可变内容写入 dataRoot、secretRoot 或明确的 workspaceRoot。

### 3.4 用户体验与物理路径解耦

“用户不需要进入 runtime 目录”不等于“系统不能有持久数据目录”。持久数据目录是实现升级、权限和多项目隔离的必要边界，应隐藏在宿主原生数据目录中。

### 3.5 默认最小副作用

安装插件不等于每次打开 Agent 都要写盘或注入上下文。普通 prompt 默认只做低成本判断，不创建 .harness，不保存 prompt，不注入经营分析知识。

## 4. 推荐的目标目录模型

### 4.1 四个一级根

| 根 | 主要内容 | 可写性 | 生命周期 |
| --- | --- | --- | --- |
| pluginRoot | 宿主 manifest、hooks、adapter、通用核心、默认 skills、只读 wiki/index | 默认只读 | 随插件版本替换 |
| dataRoot | runtime bundle、metric-cli、可变非敏感配置、缓存、锁、workspace state | 可写 | 跨插件版本持久 |
| secretRoot | auth profile、外部 blob、宿主 secret reference | 严格受限 | 独立于插件和项目 |
| workspaceRoot | 当前项目、用户明确要求落盘的报告产物 | 由项目权限决定 | 随项目存在 |

stateRoot 是由 dataRoot 和规范化后的 workspace identity 派生出来的逻辑根，不应再让每个模块自行决定。

### 4.2 推荐的物理布局

推荐的产品形态如下：

    <PLUGIN_ROOT>/
      <host-manifest>
      hooks/
      adapter/
      vendor/
        qdm-harness-core/
        html-report-kernel/
      skills/
      resources/
        wiki/
        index/
      resource-manifest.json

    <DATA_ROOT>/
      runtimes/
        <platform>/
          <metric-cli-version>/
            qdm-metric-cli
      config/
        settings.json
      cache/
      state/
        workspaces/
          <workspace-id>/
            sessions/
            diagnostics/
            jobs/
      locks/
      install-manifest.json

    <SECRET_ROOT>/
      profiles/
        default/
          auth-ref.json
          auth.blob                 # 只有 file secret 模式才存在，0600

    <WORKSPACE_ROOT>/
      .harness/
        artifacts/                  # 仅在用户明确选择项目内产物时创建
      analysis/
        main.md                     # html-report 最终产物按产品约定写入

第一版如果必须遵守“wiki 随插件发布”的产品决定，可以把 wiki/index 保留在 pluginRoot/resources，但必须满足：

- wiki/index 只读；
- 通过 resource-manifest.json 记录内容版本、schema 版本和 SHA-256；
- index 中不得写入构建机绝对路径；
- wiki/index 不承担 auth、runtime binary 或 session state；
- 后续允许无破坏地切换到 dataRoot/resources 的独立内容包。

### 4.3 宿主数据目录映射

适配层负责把宿主的持久目录映射为统一 dataRoot，核心不写死宿主路径。

优先级：

1. 宿主官方持久数据目录；
2. 产品显式配置的 data directory；
3. OS 级应用数据目录：
   - macOS：Application Support；
   - Linux：XDG data/state；
   - Windows：LOCALAPPDATA；
4. 若目录不可写，setup/doctor 必须给出明确错误，不得静默回退到 pluginRoot。

示例映射：

- Claude：优先使用宿主提供的 plugin data 语义；
- Codex：优先使用 CODEX_HOME 或宿主明确提供的数据目录；
- Hermes：使用宿主 plugin data 目录；
- OpenClaw：使用其 state 目录；
- Pi：区分 agent/package 目录和 session 目录；
- WorkBuddy/QwenPaw：必须通过实机验证并在 adapter 中显式声明；
- 没有稳定数据 API 的宿主：使用 OS fallback，不把 cache 当数据盘。

## 5. Root Context 契约

### 5.1 统一结构

宿主 adapter 调用核心时，必须提供如下结构。可以通过 JSON stdin、context file 或等价的宿主安全通道传递。

    {
      "schemaVersion": 1,
      "host": "codex",
      "pluginRoot": "/absolute/path/to/plugin",
      "dataRoot": "/absolute/path/to/data",
      "workspaceRoot": "/absolute/path/to/project",
      "stateRoot": "/absolute/path/to/data/state/workspaces/...",
      "configPath": "/absolute/path/to/data/config/settings.json",
      "secretRef": {
        "kind": "file",
        "path": "/absolute/path/to/secret"
      },
      "sessionId": "host-session-id",
      "capabilities": {
        "canWriteWorkspace": true,
        "canWriteData": true,
        "hasStableSessionId": true,
        "supportsSecretReference": true
      }
    }

### 5.2 校验规则

- 所有路径必须是绝对路径；
- 已存在的路径先 realpath，防止 symlink 造成根漂移；
- pluginRoot、dataRoot、secretRoot、workspaceRoot 必须彼此明确；
- 禁止把 workspaceRoot 解析为 plugin cache；
- 禁止把 dataRoot 或 secretRoot 解析为用户项目内任意未确认目录；
- workspace 不存在或宿主未提供 workspace 时，只允许只读能力；
- hasStableSessionId=false 时禁止创建跨轮次 session state；
- context 缺失或冲突时 fail-closed，不猜测，不回退到 process.cwd()；
- 记录 host、插件版本、核心 API 版本和资源版本，便于诊断。

### 5.3 CLI 接口

核心 CLI 增加显式参数，环境变量只作为宿主 adapter 的兼容入口：

    data-harness-cli \
      --context-file <path> \
      context

支持的显式覆盖参数：

- --plugin-root
- --data-root
- --workspace-root
- --state-root
- --config
- --secret-ref
- --session-id

命令优先级：

1. 显式 CLI 参数；
2. 结构化 Root Context；
3. 宿主 adapter 生成的兼容环境变量；
4. 旧 runtime 兼容模式；
5. 不允许隐式 process.cwd() 猜测新插件根。

## 6. 仓库源码树与职责边界

推荐调整为：

    harness-data/
    ├── packages/
    │   ├── data-harness-cli/
    │   ├── html-report-kernel/
    │   ├── harness-runtime-node/
    │   └── qdm-harness-core/       # 可选；若 CLI 已承担 core，可先不拆包
    ├── skills/
    │   ├── qdm-harness/SKILL.md
    │   └── html-report/SKILL.md
    ├── resources/
    │   ├── wikis/
    │   └── index/
    ├── plugins/
    │   ├── claude/
    │   ├── codex/
    │   ├── pi/
    │   ├── workbuddy/
    │   ├── qwenpaw/
    │   ├── hermes/
    │   └── openclaw/
    ├── scripts/
    │   ├── build-core.mjs
    │   ├── build-resource-bundle.mjs
    │   ├── build-plugin-<host>.mjs
    │   └── verify-plugin-<host>.mjs
    ├── bootstrap/
    ├── npm/
    ├── docs/
    └── .github/workflows/

规则：

- skills/ 是正文真源，插件构建时复制或打包；
- packages/ 禁止依赖宿主 API；
- plugins/<host>/ 只保存 manifest、hook、信封转换和宿主独有能力；
- html-report 与 qdm-harness 对用户表现为一个宿主插件，但内部仍保持模块边界；
- .agents/ 只保留迁移期兼容，不再作为新代码的 source of truth；
- Python adapter 只能调用稳定的 JSON/CLI 协议，不能复制 wiki 解析、authz 或报告规则。

## 7. CLI 与 runtime 改造

### 7.1 新增 RootContext 模块

新增统一模块，建议放在：

    packages/data-harness-cli/src/lib/root-context.js
    packages/harness-runtime-node/src/root-context.mjs

两者必须共享同一份字段定义、优先级和错误码。可以通过生成 JSON schema 或测试 fixture 保持一致。

### 7.2 重构路径解析

当前 PathResolver(root, paths) 只能绑定单 root。改为显式接收：

- resourceRoot：wiki、skills、index；
- dataRoot：配置、runtime binary、缓存；
- workspaceRoot：项目文件；
- stateRoot：session 和诊断；
- secretRoot 或 secretRef：授权材料。

所有逻辑路径都必须声明 owner：

| 逻辑对象 | 根 |
| --- | --- |
| wiki logical path | resourceRoot |
| read-only index | resourceRoot |
| qdm-metric-cli | dataRoot/runtimes |
| 非敏感配置 | dataRoot/config |
| auth reference | secretRoot |
| report session state | stateRoot |
| 用户最终报告 | workspaceRoot |

### 7.3 保留旧寻根但隔离兼容模式

findRoot() 不立即删除，但改名或标注为 legacy：

- 新插件路径不得调用 legacy findRoot()；
- legacy 模式只在迁移命令和旧 runtime hook 中启用；
- .harness 单独存在不能再证明一个目录是产品根；
- 新 root 必须有明确 product identity、schema version 和 manifest。

### 7.4 html-report runtime

必须移除模块加载时固定 workspace root 的行为：

- open-metric-cli-ui.mjs 当前的模块级默认 root 只能保留为 legacy fallback；
- 所有 openMetricCliUi、stopMetricCliUi、worker 都必须接收显式 workspaceRoot、stateRoot、dataRoot；
- MCP server 不应要求 workspace 里存在旧 runtime 的 config/harness-config.yaml；
- 没有 workspace 时，status/doctor 等只读工具可运行，start/write 类工具返回稳定错误码。

### 7.5 index 可重定位

wikis-index.json 和 wikis-runtime-index.json 必须：

- 不写构建机绝对 root；
- 使用逻辑资源 ID、相对路径和 resource manifest；
- 运行时通过 resourceRoot 解析；
- 搬到随机目录后仍能完成 context、show、recall；
- 内容 hash 与 wiki 资源不匹配时 fail-closed 或明确提示重新安装资源。

## 8. Hook 行为策略

### 8.1 默认模式：on-demand

普通 prompt 的默认流程：

1. hook 解析宿主 envelope；
2. 检查是否显式调用 qdm-harness skill/command；
3. 未触发时直接返回，不注入 wiki，不创建 state；
4. 触发后才读取资源并构造上下文。

### 8.2 可选模式：auto-context

允许用户或组织配置开启自动召回，但必须：

- 明确显示当前模式；
- 允许按宿主和 workspace 关闭；
- 有 context 大小上限；
- 记录命中原因但不保存完整 prompt；
- 自动模式异常时不阻塞普通编码会话。

### 8.3 authz hook

PreToolUse/工具拦截可以全局注册，但应满足：

- 非 QDM 命令快速 no-op；
- 模型提供的 auth flags 一律剥离；
- 不在普通命令环境中泄露 secret；
- 没有 stable session 或 secret reference 时 fail-closed；
- adapter 对 matcher 的实际语义做端到端测试，不依赖 README 描述。

### 8.4 状态写入时机

以下操作允许创建 durable state：

- 明确选择 report/template；
- inject-template；
- html-report start；
- 用户显式开启 diagnostics；
- setup/migrate/update。

以下操作禁止默认写 state：

- 普通 context recall；
- 普通无关编程问题；
- 只读 doctor/status；
- hook 解析失败或没有 workspace。

## 9. State 模型

### 9.1 state 分类

| 类型 | 默认位置 | 是否保存原始 prompt |
| --- | --- | --- |
| ephemeral context | 进程内 | 否 |
| report/session state | stateRoot/sessions | 默认否；需要时保存摘要 |
| html-report job | stateRoot/jobs/{job-id} | 否，保存结构化状态 |
| diagnostics | stateRoot/diagnostics | 默认脱敏 |
| 用户最终产物 | workspaceRoot | 由用户选择 |

### 9.2 workspace identity

workspace-id 由规范化后的真实路径、宿主 profile 和产品 schema 共同派生：

    sha256(realpath(workspaceRoot) + "\n" + hostProfile + "\n" + schemaVersion)

不得只使用 session ID 隔离 workspace。

### 9.3 并发和写盘

当前 state 写盘虽然使用临时文件和 rename，但没有锁。新实现必须：

- 对同一 workspace/session 加 lock 或 lease；
- 写入 schemaVersion、pluginVersion、resourceVersion；
- 检测并发更新冲突；
- 保持原子写入；
- 提供 stale lock 恢复策略；
- 不因一个坏 session 文件阻塞其他 session。

### 9.4 敏感内容

默认不保存完整 prompt。若业务确实需要跨轮次 prompt：

- 明确配置 retention；
- 脱敏或加密；
- 诊断导出必须显式触发；
- 文档明确说明 .harness/state 可能含业务数据。

## 10. Auth 与 metric-cli 方案

### 10.1 secret 来源优先级

推荐优先级：

1. 宿主 secret API 或安全 handoff；
2. secretRef 指向宿主管理的 secret；
3. 外部 0600 文件；
4. 仅开发/测试使用的环境变量；
5. 禁止把 secret 写入 plugin package。

### 10.2 禁止把 blob 注入模型可见 command

当前实现会把 --auth-blob 拼进 gated command：

- packages/data-harness-cli/src/lib/authz/metric-command.js:276
- packages/data-harness-cli/src/lib/authz/metric-command.js:303

必须优先改造 qdm-metric-cli 或 wrapper，支持以下至少一种：

- --auth-blob-file <path>；
- stdin；
- inherited file descriptor；
- host secret handle；
- wrapper 内部读取 secret 后直接 spawn，不修改模型可见命令。

在此之前，不能把“把 auth 移到 pluginRoot”当作安全修复。

### 10.3 setup/doctor

提供不依赖 workspace 的命令：

    qdm-harness setup
    qdm-harness doctor --json
    qdm-harness paths --json

setup 必须幂等，负责：

- 确认 dataRoot 可写；
- 下载并校验 metric-cli；
- 创建非敏感配置；
- 检查 secret reference；
- 写入 install manifest；
- 不创建用户项目 .harness。

首次 hook 失败时必须输出可执行的 setup 提示，不能只报“找不到 Harness root”。

## 11. 插件打包与发布

### 11.1 一个宿主一个 artifact

每个宿主独立构建和验证：

- Claude marketplace artifact；
- Codex plugin artifact；
- WorkBuddy marketplace artifact；
- Pi npm artifact；
- QwenPaw Python artifact；
- Hermes plugin artifact；
- OpenClaw plugin artifact。

用户体验仍然是“一个宿主一个 qdm-harness”，但发布流水线不能假设七个宿主共享同一个 manifest。

### 11.2 artifact 内容

每个 artifact 至少包含：

- 宿主 manifest；
- adapter/hook；
- qdm-harness-core；
- html-report kernel；
- skills；
- 只读 resource bundle；
- resource-manifest.json；
- plugin-manifest.json；
- 最小 self-test。

不包含：

- 用户 auth；
- 用户 state；
- 用户项目；
- 运行时下载后的 metric-cli；
- 构建机绝对路径；
- .git 元数据。

### 11.3 版本协议

建立以下版本字段：

- pluginVersion；
- coreApiVersion；
- resourceSchemaVersion；
- wikiContentVersion；
- metricCliVersion；
- stateSchemaVersion。

插件启动时校验兼容范围。不同 package 的 npm version 不得再隐式代表同一个产品版本；发布时由顶层 manifest 显式绑定。

### 11.4 构建顺序

1. checkout 固定 wiki revision；
2. 运行 wiki checks；
3. 构建可重定位 index；
4. 生成 resource manifest 和 hash；
5. 构建通用 core；
6. 为每个宿主拷贝/打包 adapter；
7. 在随机安装目录执行 self-test；
8. 在只读 pluginRoot + 可写 dataRoot 环境执行 smoke；
9. 发布宿主 artifact。

## 12. 迁移和兼容策略

### 12.1 兼容窗口

至少保留一个小版本窗口：

- 旧 install --dir 仍可运行；
- 新插件发现旧 runtime 时只提示 migrate，不静默继续使用旧目录；
- 旧 runtime state 和 auth 不自动覆盖新数据；
- migrate 成功前，旧路径保持可回滚。

#### 已冻结的兼容窗口决策（2026-08-29）

- `0.0.53` 是旧 `install --dir` 模型的基线版本；
- 首个包含 `qdm-harness migrate` 的版本（计划为 `0.0.54`）和其后一个正式 patch 版本（计划为 `0.0.55`）继续完整支持旧入口；
- 只有从其后的版本开始，且 Phase 4/6 的迁移、回滚、跨平台和发布周期门槛全部满足时，才允许删除旧入口；
- 若迁移首发版本号变化，窗口随之顺延，仍固定为“迁移首发版 + 一个正式 patch 版本”；
- 详细政策、停止支持门槛和用户可见要求见 `docs/legacy-installer-compatibility.md`。

### 12.2 迁移命令

提供：

    qdm-harness migrate --from <old-runtime> --to <data-root>
    qdm-harness migrate --check --from <old-runtime>

迁移步骤：

1. 校验旧 runtime identity 和版本；
2. 复制/登记旧 wiki content version；
3. 迁移 metric-cli 状态和校验摘要；
4. 将 auth 转为 secret reference，不复制到 plugin package；
5. 迁移 .harness/state 到 workspace identity 对应的 stateRoot；
6. 迁移 html-report session/job；
7. 生成兼容报告；
8. 通过 doctor 后才允许用户切换。

### 12.3 旧数据映射

| 旧位置 | 新位置 |
| --- | --- |
| OLD_RUNTIME/wikis | plugin resource 或 dataRoot resource cache |
| OLD_RUNTIME/.harness/index | plugin resource index 或 dataRoot index cache |
| OLD_RUNTIME/.harness/state | dataRoot/state/workspaces/{workspace-id} |
| OLD_RUNTIME/config/dev-auth.blob | secretRoot/secret provider |
| OLD_RUNTIME/config/harness-config.yaml | dataRoot non-secret config |
| OLD_RUNTIME/bin/qdm-metric-cli | dataRoot/runtimes/{platform}/{version} |
| OLD_RUNTIME/plugins | 对应宿主 artifact，不直接作为新 dataRoot |

### 12.4 回滚

- migrate 不删除旧数据；
- 新插件不可用时可切回旧 hook；
- dataRoot 迁移使用 copy + 校验 + pointer，而不是原地移动；
- 迁移日志不包含 auth blob 和完整 prompt。

## 13. 分阶段实施计划

可勾选的执行清单、任务编号和验证入口见第 20 节。

### Phase 0：契约和安全基线

交付：

- Root Context schema；
- 四根目录和 owner 表；
- auth transport 设计；
- state schema 和 lock 设计；
- host capability matrix；
- threat model；
- acceptance test 清单。

退出条件：

- 产品确认 dataRoot/secretRoot 不是可选概念；
- 明确默认 hook 模式为 on-demand；
- 明确旧 installer 兼容窗口。

### Phase 1：核心双根重构

交付：

- RootContext；
- CLI 显式 root 参数；
- runtime-node 统一解析；
- PathResolver 按 owner 分流；
- findRoot legacy 隔离；
- no-workspace 只读/写入 fail-closed；
- state 按需写入和基础 lock。

退出条件：

- 双根单元测试；
- 两个临时 workspace 并行测试；
- pluginRoot 只读测试通过；
- 旧 CLI 测试保持通过。

### Phase 2：选一个宿主完成 golden path

优先选择有明确持久数据语义的宿主；若业务优先 Codex，也必须先用 CODEX_HOME/显式 dataRoot 建模，而不能依赖 cache。

交付：

- clean install；
- setup；
- doctor；
- hook；
- explicit skill；
- report session；
- reload/new-session 验证；
- 只读 pluginRoot + 可写 dataRoot。

退出条件：

- 插件目录被替换后 auth、runtime、state 均保留；
- 普通 prompt 不产生 state；
- explicit report flow 完成一次端到端运行。

### Phase 3：资源和打包流水线

交付：

- wiki/index resource bundle；
- resource manifest/hash；
- index 去绝对 root；
- 每宿主 build/verify/self-test；
- 版本绑定 manifest；
- CI clean-room smoke。

退出条件：

- artifact 拷贝到随机目录仍可运行；
- wiki/index 与 plugin 版本不匹配时有清晰错误；
- release 产物不含 auth 和 .git。

### Phase 4：迁移和兼容

交付：

- migrate/migrate-check；
- 旧 runtime state/auth/report 映射；
- 回滚；
- 兼容窗口文档；
- telemetry/diagnostics（仅非敏感元数据）。

退出条件：

- 至少覆盖 macOS、Linux、Windows 各一条迁移路径；
- 迁移失败不破坏旧 runtime；
- 两次 migrate 幂等。

### Phase 5：扩展到其他宿主

顺序建议：

1. Claude；
2. Codex；
3. WorkBuddy；
4. Pi；
5. OpenClaw；
6. Hermes；
7. QwenPaw。

每个宿主都必须独立完成：

- manifest discovery；
- install；
- enablement；
- hook envelope；
- workspace handoff；
- secret handoff；
- clean uninstall/reinstall；
- upgrade/rollback。

### Phase 6：删除旧 installer

仅当以下条件全部满足后执行：

- 新宿主插件覆盖率达到产品目标；
- 迁移成功率和失败回滚经过验证；
- 文档、doctor、support runbook 已更新；
- 至少一个完整发布周期没有阻塞性回归；
- 明确最后一个旧版本的停止支持日期。

## 14. 测试和验收矩阵

### 14.1 核心路径测试

- CLI 从 pluginRoot 读取 wiki/index；
- CLI 从 dataRoot 读取 config/runtime；
- state 永远写 stateRoot；
- workspaceRoot 缺失时读操作成功、写操作稳定失败；
- 从嵌套目录启动时使用宿主声明的 workspace；
- .harness 单独存在不会被误判为 pluginRoot；
- CLI 与 runtime-node 对同一 context 得出同一 workspace。

### 14.2 生命周期测试

- pluginRoot 设为只读；
- dataRoot 设为可写；
- pluginRoot 版本目录替换；
- dataRoot 版本升级；
- secretRoot 权限为 0600；
- 重新安装插件不覆盖 state/auth；
- 卸载插件后 dataRoot 可独立保留或清理。

### 14.3 多项目和并发

- project A/B state 不串；
- 同一项目两个 session 不互相覆盖；
- 两个 hook 进程同时写同一 session 时 lock 生效；
- stale lock 可恢复；
- session ID 中含特殊字符时仍保持稳定 identity。

### 14.4 Hook 行为

- 普通编码 prompt 不注入 QDM context；
- 显式 skill 注入正确 wiki；
- 普通 prompt 不创建 .harness；
- template selection 后才创建 durable state；
- non-QDM tool 不触发昂贵 authz；
- authz hook 失败时不执行 gated command；
- hook 不把完整 blob 写入模型可见 command。

### 14.5 发布和迁移

- wiki/index 在随机目录可运行；
- index 不含构建机绝对路径；
- 每个宿主 artifact 自包含；
- artifact 不含 auth、state、.git；
- 旧 runtime migrate 后报告可继续；
- migrate 失败后旧 runtime 可继续使用；
- 两次 migrate 结果一致；
- CI 发布产物与安装器实际消费内容一致。

## 15. 运行、诊断和支持

doctor --json 至少输出：

- host；
- pluginRoot；
- dataRoot；
- workspaceRoot；
- stateRoot；
- plugin/core/resource/state 版本；
- metric-cli 路径和 hash；
- secret source 类型，不输出 secret 内容；
- 只读/可写检测；
- hook enablement；
- 当前 hook 模式；
- migration 状态。

错误码建议：

- QDM_CONTEXT_INVALID
- QDM_PLUGIN_ROOT_UNAVAILABLE
- QDM_DATA_ROOT_UNAVAILABLE
- QDM_WORKSPACE_REQUIRED
- QDM_STATE_LOCKED
- QDM_RESOURCE_MISMATCH
- QDM_SECRET_UNAVAILABLE
- QDM_SETUP_REQUIRED
- QDM_MIGRATION_REQUIRED

日志规则：

- 不输出完整 auth blob；
- 不输出完整 prompt；
- 路径可输出，但要区分用户可见诊断和 debug 日志；
- 诊断默认只保留结构化元数据。

## 16. 必须先拍板的产品决策

以下问题必须在 Phase 0 结束前明确：

1. 默认 hook 是 on-demand 还是 auto-context。推荐 on-demand。
2. workspace state 默认外置还是项目内。推荐外置，项目内仅保存用户明确要求的 artifacts。
3. wiki 是否允许独立版本。推荐允许；第一版可继续随插件只读发布。
4. auth 是否允许本地 blob。推荐生产使用 secret reference/file，开发模式才允许 fixture/env。
5. 是否允许同一 workspace 同时激活多个宿主。推荐核心可共享，但同一 workspace/profile 只允许一个 active adapter 写 durable state。
6. 旧 installer 支持到哪个版本。推荐至少保留一个兼容窗口。
7. html-report 是否把 analysis/main.md 复制到项目根。推荐把最终用户产物放 workspace，session/debug 留在 stateRoot。
8. 没有 workspace 时哪些 MCP/skill 可用。推荐只开放只读能力。

## 17. 当前分支作为起点的直接任务清单

按优先级：

### P0

- 新增 RootContext 和四根路径 owner；
- 移除新插件对 findRoot() 的依赖；
- 禁止 auth/metric-cli 写入 pluginRoot；
- 设计 auth blob 的 file/stdin/FD 传输；
- 修复发布 staging 与 installer 消费内容不一致；
- 增加 pluginRoot 只读、dataRoot 可写集成测试；
- 保留旧 installer 并实现迁移入口。

### P1

- 把 writeWikiPlanState 改为事件驱动、按需持久化；
- 默认关闭普通 prompt 的全局 wiki 注入；
- 统一 CLI/runtime 的环境变量优先级；
- 统一 session/workspace identity；
- index 去绝对 root；
- 建立宿主 artifact 的版本绑定和 clean-room smoke。

### P2

- wiki 独立资源发布；
- 统一跨宿主 UI/doctor 展示；
- 清理 .agents 兼容层；
- 优化大 wiki 的压缩和 cache 共享；
- 完善 Python/JS adapter 的协议生成。

## 18. Definition of Done

只有满足以下条件，才能宣布“全宿主插件化完成”：

- 用户不需要 cd 到 runtime 目录；
- pluginRoot 可只读；
- dataRoot、secretRoot、workspaceRoot 职责分明；
- 普通 prompt 不产生隐式持久副作用；
- report/session state 按 workspace 隔离；
- auth 不进入模型可见 command；
- wiki/index artifact 可重定位；
- 插件升级或替换不会丢数据；
- 旧 runtime 可以迁移并可回滚；
- 七个宿主都有独立的安装、启用和升级验证；
- release artifact 与实际安装内容一致；
- 文档、doctor、错误码和 support runbook 已同步。

## 19. 评审意见摘要

应批准：

- 插件化；
- pluginRoot / workspaceRoot 分离；
- 通用核心 + 宿主 adapter；
- 用户层面每宿主一个插件；
- 按需创建 durable state。

应退回：

- “插件目录是唯一产品根”；
- 在插件目录写 auth、metric-cli、可变 config；
- 把宿主 cache 当作稳定可写目录；
- 先删除 install --dir 再补迁移；
- 默认对所有普通 prompt 做 wiki 注入；
- 继续把 auth blob 拼到模型可见 command。

最推荐的最终方案是：

> 用户只感知一个宿主插件；插件目录只读且可替换；持久数据进入宿主原生 dataRoot；密钥独立管理；项目产物进入 workspaceRoot；核心通过显式 Root Context 工作；默认按需触发；旧 runtime 通过迁移命令过渡。

## 20. 分阶段 TODO 清单

本节把上面的方案转换为可执行、可验收的任务。所有任务默认未完成，用 `[x]` 标记完成；任务编号用于 issue、提交和验收记录。

### 20.1 执行顺序和状态规则

- 硬依赖：Phase 0 → Phase 1 → Phase 2 → Phase 4 → Phase 5 → Phase 6。
- Phase 3 可在 Phase 1 完成后提前准备，但发布 smoke 必须同时满足 Phase 2 的 golden path。
- Phase 4 必须在可运行 artifact（Phase 2/3）上验证；Phase 5 必须同时依赖 Phase 2、3、4 的协议和证据。
- 任何涉及 auth、路径解析、迁移和发布内容的任务，未通过对应验收前不得标记完成。
- 新增命令或测试在实现前只能作为“待新增入口”，不得把现有旧模型的绿灯测试当作新架构验收。

#### 当前进度快照（更新于 2026-08-29）

- 已完成 Root Context v1 的 CLI/runtime 实现、路径校验、五根 owner 映射、优先级解析、错误码和跨实现 fixture。
- 已完成 PathResolver 双根分流、legacy `findRoot()` 隔离、结构化 context 接入、按需 hook、state schema/原子写入/基础锁与 stale-lock 恢复，以及 html-report 显式 roots 改造。
- 已完成 Codex golden-path 的决策记录、能力矩阵、验收矩阵、npm 层 `setup`/`paths`/结构化 `doctor`、hook envelope 转换、缺 workspace fail-closed 和显式 report wrapper。
- 本轮新增并验证 `qdm-harness setup|paths|doctor|report` 入口；setup 产物固定在 `dataRoot`，report session 固定在 `stateRoot`，Codex hook 在 runtime 不可发现时给出可执行 setup 提示。
- 已完成 auth `secretRef`/0600 文件通道的最小安全实现、敏感信息脱敏、wiki index 可重定位改造，以及 installer staging/plugins 修复。
- 已完成 CLI/runtime/installer/WorkBuddy 回归与打包校验；新增 npm golden-path、hook envelope 和 report state-root 测试均通过。
- 已完成 Codex clean-room/只读 pluginRoot 自动化链路、跨进程 report session 恢复、插件目录替换后的 auth/runtime/state 复用，以及 confirmed `result.json`→workspace `analysis/main.md` 的可复核 E2E。
- 已完成资源 `resource-manifest.json`（相对路径、内容版本和 SHA-256）与 runtime staging、Pi dist、npm tarball 的统一 artifact 审计；release staging 不再携带 auth fixture 或测试文件。
- 已知环境限制：完整 `html-report-stage-runner.test.mjs` 有 55 pass，另 2 项依赖本机 `codebuddy` 可执行文件而失败；这两项不覆盖本轮改动，不能替代真实 Codex UI reload 的验收。
- 本轮完成 Phase 3 的 cross-host manifest/核心包版本绑定、runtime/PI artifact 审计、安装器对新 manifest archive 的严格校验，以及 ZIP 解压后的二次 CI artifact 校验；PI agent extension 路径保持相对可搬迁。
- 本轮完成 Phase 3 release ZIP clean-room smoke：随机安装目录、只读 pluginRoot、可写 dataRoot、MCP self-test、setup/doctor/report 全链路均由自动化覆盖。
- 本轮完成 Phase 4 migration MVP：只读 `migrate --check`、copy+hash/tree 校验+pointer、版本化 metric runtime、workspace state/session 映射、secretRef/0600、doctor gate、幂等/损坏/源变更/软链/权限/回滚失败防护。
- 本轮完成 Phase 3 的七宿主 artifact 矩阵：新增统一 `build|verify|self-test` 入口，分别产出 Claude、Codex、WorkBuddy、Pi、QwenPaw、Hermes、OpenClaw 的隔离 artifact、顶层版本绑定 manifest 和宿主描述；日常 PR/主干 CI 与 release validation 均已配置接入矩阵。Pi 打包新增 `PI_HTML_REPORT_OUTPUT_DIR`，避免与其他构建/测试争用源码 `dist`。
- 本轮可复核验证：`cd npm && npm test -- --test-concurrency=1` 为 175 pass；`npm pack --dry-run` 与 `npm run verify:artifact` 均通过；`packages/data-harness-cli` 为 82 pass + 2 skip；`packages/harness-runtime-node` 为 17 pass；Pi artifact 为 5 pass；新增 artifact/pinned-Wiki/relocation 脚本测试为 5 pass。
- 本轮补充验证：宿主 artifact/build-manifest/verifier 矩阵为 8 pass；Pi artifact 测试为 5 pass，并与宿主矩阵并发运行通过；Codex runtime golden-path 为 15 pass，MCP self-test 为 10/10；新增 CI workflow 与 release workflow 的 YAML 解析、相关 Node 语法检查及 `git diff --check` 均通过。
- 本轮新增证据：`config/wikis-revision.json` 固定 Wiki commit `95a19b5c4e7e2999862e7d55f52b04a2ef869d23`，`wikis check-all` 六项检查通过；relocation smoke 在随机目录完成 context/show/recall；runtime ZIP 构建、自检和 npm tarball 审计通过；旧 runtime 支持显式路径/环境变量发现并只给出 migrate 提示；迁移成功/失败均验证旧 hook 可继续运行，并覆盖三平台命名契约 fixture。
- 最后本地复核（2026-08-29）：七宿主 artifact 可在隔离输出目录完成 build/verify/self-test，Pi 的独立输出目录回归通过；当前没有新增失败或未归因回归。
- 远端 PR 验证（2026-08-29）：`harness-data#74` 的 Verify Host Artifacts run `33266302354` 全部通过；七宿主 artifact build/verify/self-test 通过，Linux、macOS、Windows migration job 均通过并上传 TAP 证据。
- 三平台迁移证据：Linux X64 为 19 pass；macOS ARM64 为 19 pass；Windows X64 为 16 pass、3 项目录 symlink 能力测试明确 skip、0 fail。三个 evidence artifact 均绑定提交 `d44b64799d78ba4d548673fa20f15f2ca042c1ab`。
- 发布相关远端证据：Wikis Compatibility run `33266302360` 通过；Publish CLI Container run `33266302347` 的 multi-arch build 通过。期间修复了不可达的 Wikis gitlink、私有子模块 checkout token 和 `.dockerignore` 排除 CLI 入口的问题。
- Wikis 修复已基于最新远端 master 重放为 revision `b76aef3cea6d6d99a8411f2afe5bc41929aed8f5`，并提交到 `harness-data-wikis#14`；主仓 gitlink 与 `config/wikis-revision.json` 已同步。
- P4-12 现场验证完成：使用 `/Users/pengmd/c/qdm/harness-data` 的真实 `0.0.53` runtime 快照，完成 check、迁移、doctor、二次幂等、business session 读取及 html-report `paused → running → paused` 恢复；原 runtime 未被修改。证据见 `docs/migration-field-validation-2026-08-29.md`。
- 现场验证补齐四个兼容缺口：新 host artifact pluginRoot 身份、旧 `.agents/` 布局、空壳 canonical session 目录冲突，以及迁移后 `pipeline-state.json.sessionDir` 的旧绝对路径。
- 当前仍未完成：P3-EXIT-04 仍需合并后由 master/release 流程证明正式发布内容与 installer 解包一致；仍缺真实 Codex UI reload/new-session 验收。
- 下一步按依赖顺序：先合并 `harness-data-wikis#14`，再评审合并 `harness-data#74`；归档 master/release validation 证据后，完成真实 Codex UI smoke，再进入其余宿主的 Phase 5 验证。

### 20.2 Phase 0：契约和安全基线

目标：先把边界、协议和安全决策冻结，阻塞后续代码实现。

- [x] P0-01（产品）确认八项产品决策：on-demand、state 外置、wiki 版本策略、auth 本地 blob 范围、多宿主并行、旧 installer 支持版本、`analysis/main.md` 位置、无 workspace 时开放能力。
- [x] P0-02（核心）定义 Root Context schema v1：字段、类型、必填项、默认值、版本兼容范围和错误码。
- [x] P0-03（核心）固化 `pluginRoot`、`dataRoot`、`secretRoot`、`workspaceRoot`、`stateRoot` 的 owner 映射和生命周期。
- [x] P0-04（核心）定义路径校验：绝对路径、`realpath`、symlink 防漂移、根之间冲突检测、禁止隐式 `process.cwd()` 回退。
- [x] P0-05（CLI/runtime）定义显式 CLI 参数、结构化 context、兼容环境变量和 legacy 模式的优先级。
- [x] P0-06（安全）完成 auth transport 方案选型，至少覆盖宿主 secret API、`secretRef`、0600 文件、stdin/FD/wrapper 中的一种安全通道。
- [x] P0-07（安全）编写 threat model：pluginRoot 写入、auth blob 泄露、路径穿越、symlink、日志和 prompt 敏感信息。
- [x] P0-08（状态）定义 workspace/session identity、state schema、lock/lease、并发冲突和 stale-lock 恢复规则。
- [x] P0-09（宿主）建立七宿主 capability matrix，记录 workspace/data/secret/session/hook/reload 能力及证据来源。
- [x] P0-10（质量）建立验收矩阵和基线命令，区分“现有回归测试”和“待新增双根/迁移/只读测试”。
- [x] P0-11（兼容）明确旧 `install --dir` 的兼容版本范围、迁移入口和停止支持条件；详见 `docs/legacy-installer-compatibility.md`。
- [ ] P0-12（文档）补齐或归档本方案引用的 handoff 调研文档；若无法恢复，记录缺口并用当前代码/发布链路重新留证。

退出条件：

- [x] P0-EXIT-01：产品确认 `dataRoot`/`secretRoot` 是必需概念，pluginRoot 不作为数据盘。
- [x] P0-EXIT-02：默认 hook 模式确定为 on-demand。
- [x] P0-EXIT-03：Root Context、state、auth transport、capability matrix 和验收清单均有可评审文档或 fixture。
- [x] P0-EXIT-04：旧 installer 兼容窗口和迁移入口获得确认。

最小验证：新增合法、缺失、冲突、相对路径和 symlink Root Context fixture；CLI 与 runtime-node 对合法 fixture 得到同一规范化结果，非法 fixture 返回稳定错误码且不回退到 `process.cwd()`。

### 20.3 Phase 1：核心双根重构

目标：让 CLI、runtime 和 html-report 都使用同一份显式 Root Context。

- [x] P1-01（CLI）实现 `packages/data-harness-cli/src/lib/root-context.js`。
- [x] P1-02（runtime）实现 `packages/harness-runtime-node/src/root-context.mjs`。
- [x] P1-03（核心）生成或共享 schema、字段定义、错误码和跨语言测试 fixture，避免 CLI/runtime 分叉。
- [x] P1-04（CLI）增加 `--context-file`、`--plugin-root`、`--data-root`、`--workspace-root`、`--state-root`、`--config`、`--secret-ref`、`--session-id`。
- [x] P1-05（CLI/runtime）统一宿主兼容环境变量及优先级，覆盖 `HARNESS_WORKSPACE_ROOT`、`CODEX_WORKSPACE_ROOT` 等现有入口。
- [x] P1-06（核心）重构 `PathResolver`，按 resource/data/workspace/state/secret owner 分流。
- [x] P1-07（兼容）将 `findRoot()` 隔离为 legacy，仅允许迁移命令和旧 runtime hook 调用；新插件路径不得调用。
- [x] P1-08（运行时）实现 no-workspace 读操作可用、写操作 fail-closed，并返回 `QDM_WORKSPACE_REQUIRED` 等稳定错误码。
- [x] P1-09（状态）实现按需 state 创建、schema/version 写入、原子写入、基础 lock 和 stale-lock 恢复。
- [x] P1-10（html-report）移除模块级 workspace 默认值；让 UI、stop 和 worker 接收显式 `workspaceRoot`、`stateRoot`、`dataRoot`。
- [x] P1-11（测试）增加双根、pluginRoot 只读、A/B workspace 并行、坏 session、并发 lock 和 stale-lock fixture。
- [x] P1-12（回归）运行 `cd packages/data-harness-cli && node --test`、`cd packages/harness-runtime-node && node --test`，并记录新增失败的归因。

退出条件：

- [x] P1-EXIT-01：双根及 owner 单元测试通过，CLI/runtime 对同一 context 解析一致。
- [x] P1-EXIT-02：pluginRoot 只读时 context/show/recall 等读操作成功，config/runtime/state/secret 不写入 pluginRoot。
- [x] P1-EXIT-03：workspace 缺失时写操作稳定失败，两个 workspace 并行时 state 不串。
- [x] P1-EXIT-04：旧 CLI 回归测试保持通过。

### 20.4 Phase 2：单宿主 golden path

目标：选一个具备明确持久数据语义的宿主，跑通从安装到报告的完整生命周期。

- [x] P2-01（宿主）选择首个 golden-path 宿主，记录 dataRoot 映射、secret handoff 和 session 能力；若选 Codex，明确使用 `CODEX_HOME`/显式 dataRoot 而非 cache。
- [x] P2-02（安装）实现可重复执行的 clean-install fixture。
- [x] P2-03（配置）实现幂等 `qdm-harness setup`：确认 dataRoot、下载/校验 metric-cli、创建非敏感配置、检查 secret reference、写 install manifest，且不创建项目 `.harness`。
- [x] P2-04（诊断）实现 `qdm-harness doctor --json` 和 `qdm-harness paths --json`，输出五根、版本、runtime hash、secret source 类型和读写能力。
- [x] P2-05（hook）实现宿主 hook envelope → Root Context 的转换和首次失败时的可执行 setup 提示。
- [x] P2-06（入口）接入 explicit skill/command，并验证普通 prompt 默认不注入 wiki。
- [x] P2-07（报告）接入 report/session state，显式 report/template 才创建 durable state。
- [x] P2-08（生命周期）验证 reload/new-session 后 auth、runtime、state 和 report session 可恢复（自动化进程/插件替换模拟；Codex UI 实机留给 Phase 5）。
- [x] P2-09（权限）在只读 pluginRoot + 可写 dataRoot 环境运行完整链路。
- [x] P2-10（端到端）完成一次 explicit report flow，并保存可复核的输入、输出和诊断摘要。
- [x] P2-11（副作用）验证普通 prompt 不创建 state、不创建 `.harness`，只读 doctor/status 不写盘。

退出条件：

- [x] P2-EXIT-01：替换插件目录后 auth、runtime、state 均保留。
- [x] P2-EXIT-02：`setup` 幂等且不创建用户项目 `.harness`；`doctor --json` 不输出 secret 内容。
- [x] P2-EXIT-03：explicit report flow 端到端通过，普通 prompt 无 durable state。

最小验证：`cd npm && npm test -- --test-concurrency=1`；宿主 clean-install/setup/doctor/reload fixture；html-report 运行 `node plugins/qdm-html-report/mcp/server.mjs --self-test`（若该宿主使用该 MCP）。

### 20.5 Phase 3：资源和打包流水线

目标：产出可重定位、自包含、可验证且与安装器一致的宿主 artifact。

- [x] P3-01（资源）固定 wiki revision，运行 wiki checks。
- [x] P3-02（资源）构建可重定位的 `wikis-index.json` 和 `wikis-runtime-index.json`。
- [x] P3-03（资源）删除 index 中的构建机绝对路径，改用 resource ID、相对路径和 `resourceRoot`。
- [x] P3-04（资源）生成 `resource-manifest.json`，记录内容版本、schema 版本和 SHA-256。
- [x] P3-05（核心）构建通用 core 与 html-report kernel，并显式记录版本字段。
- [x] P3-06（发布）为每个宿主建立独立 build/verify/self-test 脚本（本地实现与矩阵验证完成；远端 CI 运行证据由 P3-EXIT-04 管控）。
- [x] P3-07（发布）生成顶层 manifest，绑定 plugin/core/resource/state/metric-cli 版本和兼容范围。
- [x] P3-08（安装）修复 CI staging 与 installer 实际消费内容不一致，确保 top-level plugins 等必需内容被安装。
- [x] P3-09（验证）在随机安装目录、只读 pluginRoot + 可写 dataRoot 的 clean-room 环境执行 self-test/smoke。
- [x] P3-10（审计）扫描 artifact，确认不含 auth、state、项目文件、`.git`、metric-cli 下载结果和构建机绝对路径。
- [x] P3-11（发布）验证资源或插件版本不匹配时返回清晰错误，并完成 `npm pack --dry-run` 等包内容检查。

退出条件：

- [x] P3-EXIT-01：artifact 复制到随机目录后仍可完成 context/show/recall。
- [x] P3-EXIT-02：资源 hash/version 不匹配时 fail-closed 或给出明确重装提示。
- [x] P3-EXIT-03：每个宿主 artifact 自包含，release 产物不含 auth、state、`.git` 和绝对路径；远端证据为 PR `#74` / run `33266302354`。
- [ ] P3-EXIT-04：CI 发布内容与安装器实际解包内容一致。

最小验证：`node scripts/verify-pinned-wikis.mjs`、`./bin/data-harness-cli wikis check-all`、`./bin/data-harness-cli wikis build-index`、`node scripts/verify-wikis-relocation.mjs`；运行 `scripts/build-runtime-artifact.sh`；Pi 执行 `npm --prefix plugins/pi-html-report run build`、`run verify`、`npm test`；npm 执行 `npm run verify:artifact`。

### 20.6 Phase 4：迁移和兼容

目标：在不破坏旧 runtime 的前提下，把旧数据安全迁移到四根模型。

- [x] P4-01（兼容）保留至少一个小版本的旧 `install --dir` 兼容窗口；通过显式路径或环境变量发现旧 runtime 时只提示 migrate，不自动迁移。
- [x] P4-02（CLI）实现只读 `qdm-harness migrate --check --from <old-runtime>`。
- [x] P4-03（CLI）实现 `qdm-harness migrate --from <old-runtime> --to <data-root>`。
- [x] P4-04（迁移）校验旧 runtime identity、版本和 manifest，再执行迁移。
- [x] P4-05（迁移）迁移/登记 wiki content version、index 和 metric-cli 校验摘要。
- [x] P4-06（安全）将旧 auth 转为 secret reference，禁止复制到 plugin package；迁移日志不得包含 blob 或完整 prompt。
- [x] P4-07（状态）将旧 `.harness/state` 映射到 workspace identity 对应的 stateRoot，并迁移 html-report session/job。
- [x] P4-08（回滚）使用 copy + 校验 + pointer 实现迁移，保留旧数据和旧 hook 可回滚路径。
- [x] P4-09（诊断）生成兼容报告和非敏感 diagnostics，doctor 通过后才允许切换。
- [x] P4-10（跨平台）为 macOS、Linux、Windows 各准备至少一条迁移 fixture/验证路径；远端三平台 runner 证据为 run `33266302354`。
- [x] P4-11（幂等）验证成功迁移、坏版本、权限失败和重复 migrate 的行为。
- [x] P4-12（现场）使用真实旧 `0.0.53` runtime 验证 business-report/html-report session 可重新打开、继续运行，且旧 runtime 保持可回滚；见 `docs/migration-field-validation-2026-08-29.md`。

退出条件：

- [x] P4-EXIT-01：迁移失败不修改或破坏旧 runtime，旧 hook 仍可使用。
- [x] P4-EXIT-02：迁移成功后旧报告、session 和 runtime 状态可继续使用。
- [x] P4-EXIT-03：同一输入连续执行两次 migrate，结果一致且日志不泄露敏感内容。

### 20.7 Phase 5：扩展到其他宿主

目标：按既定顺序为其余宿主建立独立 artifact、适配层和生命周期证据。

每个宿主都必须完成以下通用检查：manifest discovery、install、enablement、hook envelope、workspace handoff、secret handoff、clean uninstall/reinstall、upgrade/rollback、reload/new-session，以及只读 pluginRoot + 可写 dataRoot 验证。

#### P5-01 Claude

- [ ] 完成 discovery/install/enablement 和 hook envelope 验证。
- [ ] 完成 workspace/secret handoff、卸载重装、升级回滚 smoke。
- [ ] 记录 artifact、版本、能力和失败证据到 capability matrix/runbook。

#### P5-02 Codex

- [ ] 完成 discovery/install/enablement 和 hook envelope 验证。
- [ ] 完成 `CODEX_HOME`/显式 dataRoot、workspace/secret handoff、卸载重装、升级回滚 smoke。
- [ ] 记录 artifact、版本、能力和失败证据到 capability matrix/runbook。

#### P5-03 WorkBuddy

- [ ] 通过实机确认 plugin data、workspace 和 session API，再实现 adapter。
- [ ] 完成 hook、secret handoff、卸载重装、升级回滚 smoke；能力缺口必须显式标注。
- [ ] 记录 artifact、版本、能力和失败证据到 capability matrix/runbook。

#### P5-04 Pi

- [ ] 完成 npm artifact 的 discovery/install/enablement、hook 和 session 验证。
- [ ] 完成 workspace/secret handoff、clean profile、卸载重装、升级回滚 smoke。
- [ ] 记录 `build`/`verify`/`test` 输出及 artifact 证据。

#### P5-05 OpenClaw

- [ ] 确认宿主 state 目录与 session 能力，完成 discovery/install/enablement/hook。
- [ ] 完成 workspace/secret handoff、卸载重装、升级回滚 smoke。
- [ ] 记录 artifact、版本、能力和失败证据到 capability matrix/runbook。

#### P5-06 Hermes

- [ ] 确认宿主 plugin data 目录与 secret API，完成 discovery/install/enablement/hook。
- [ ] 完成 workspace/secret handoff、卸载重装、升级回滚 smoke。
- [ ] 记录 artifact、版本、能力和失败证据到 capability matrix/runbook。

#### P5-07 QwenPaw

- [ ] 通过实机确认 Python adapter 的 data/workspace/session/secret 能力。
- [ ] 完成 discovery/install/enablement/hook、卸载重装、升级回滚 smoke。
- [ ] 记录 artifact、版本、协议和失败证据到 capability matrix/runbook。

每个宿主的退出条件：

- [ ] 可在任意项目目录启动并使用插件，不把 plugin cache 当 workspace/dataRoot。
- [ ] 普通 prompt 无隐式 wiki 注入和 durable state；explicit skill/report flow 可运行。
- [ ] reinstall/upgrade 不丢 auth、runtime、state、report。
- [ ] 宿主独立 smoke test 可重复执行并有可复核 PASS 记录。

### 20.8 Phase 6：删除旧 installer

目标：在覆盖率、迁移和发布证据完整后，再移除 legacy installer。

- [ ] P6-01 汇总七宿主覆盖率、安装/启用/升级/回滚 smoke 结果，达到产品目标。
- [ ] P6-02 汇总迁移成功率、失败回滚率、跨平台覆盖和幂等验证结果。
- [ ] P6-03 同步文档、doctor、错误码、迁移指引和 support runbook。
- [ ] P6-04 完成至少一个完整发布周期的回归观察，确认无阻塞性回归。
- [ ] P6-05 确定并公布最后一个旧版本停止支持日期，发布 deprecation 通知。
- [ ] P6-06 保留可审计的旧版本/回滚包后，移除旧 installer 入口及 legacy 路径代码、测试和文档。
- [ ] P6-07 执行最终全宿主 clean-install、activation、upgrade、migration、rollback smoke，并归档证据。

退出条件：

- [ ] P6-EXIT-01：满足第 18 节 Definition of Done 的全部条目。
- [ ] P6-EXIT-02：发布 artifact、安装器消费内容和 support runbook 三者一致。
- [ ] P6-EXIT-03：旧 installer 停止支持日期已对用户可见，迁移路径仍可审计和回滚。

### 20.9 验证入口索引

- Installer 回归：`cd npm && npm test -- --test-concurrency=1 && npm pack --dry-run`。
- CLI 回归：`cd packages/data-harness-cli && node --test`。
- Runtime 回归：`cd packages/harness-runtime-node && node --test`。
- Wiki 资源：`node scripts/verify-pinned-wikis.mjs`、`./bin/data-harness-cli wikis check-all`、`./bin/data-harness-cli wikis build-index`、`node scripts/verify-wikis-relocation.mjs`。
- html-report self-test：`node plugins/qdm-html-report/mcp/server.mjs --self-test`。
- Pi artifact：`npm --prefix plugins/pi-html-report run build`、`run verify`、`npm test`。
- Runtime artifact：`scripts/build-runtime-artifact.sh --output-dir <dir> --version <tag>`。
- Host artifact matrix：`node scripts/host-artifact.mjs build --host all --output-dir <dir> --version <tag>`，随后执行同一脚本的 `verify` 与 `self-test` 子命令。
- npm artifact：`cd npm && npm run verify:artifact`。
- 发布链路：按 `.github/workflows/release.yml` 和 `.github/workflows/publish-cli-release.yml` 的 clean-room、版本、资源和安装器检查执行；真实 CI 发布仍待运行周期证据。

以上命令只证明对应实现已通过本地验证。P3-EXIT-03、P4-10 与 P4-12 已分别补远端 CI、真实平台 runner 和真实旧 runtime 证据；P3-EXIT-04 以及 Phase 5/6 仍需正式发布或独立宿主证据，不能用模拟 fixture 替代。
