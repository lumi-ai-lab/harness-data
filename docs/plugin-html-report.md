# html-report Plugin 使用指南

## 概述

`qdm-html-report` Plugin 为 Codex CLI 和 ChatGPT 桌面 App 提供 html-report 流水线能力。首版跑到 `analysis/main.md`（A_CONFIG → B0 → B2_WRITER → B2_MAIN），不做 B25/B3/B4/B5 或 P5 Designer。B2_MAIN 之后可按用户明确确认，用 `md2html` 在同级生成 `analysis/main.html`。

Plugin 同时包含两个核心组件：

| 组件 | 来源 | 作用 |
|------|------|------|
| **MCP server** | `.mcp.json` → `mcp/server.mjs` | 5 个工具：建会话、推进流水线、提交 caption、可选 HTML 导出、查状态 |
| **Skill** | `skills/html-report/SKILL.md` | 流程指令，模型按需加载，知道怎么调 MCP 工具 |

安装 Plugin 后，MCP server 自动注册，Skill 自动发现，用户不需要手动写任何配置。

## 架构

```
              现有 PI 脚本（原地复用，不搬不拆）
        Session / fetch-entry / evidence / compose-main
                     │
              本地 Node MCP（无外部依赖）
        html_report_start / next / submit_writer / generate_html / status
                     │
              Codex Plugin（唯一对外界面）
           .mcp.json  +  SKILL.md  +  plugin.json
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
     Codex CLI            ChatGPT 桌面 App
     有 codex             没有 codex 也能跑
```

运行时最低依赖：Node、`qdm-metric-cli`、`md2html`（仅在用户确认导出 HTML 时调用）、仓库、ChatGPT App **或** Codex CLI。不依赖 `codex` 二进制、PI、hooks、custom agents、浏览器。

## 文件结构

```
仓库根/
  .agents/plugins/
    marketplace.json                 ← Codex marketplace 声明（发现入口）
  plugins/
    qdm-html-report/
      .codex-plugin/plugin.json      ← Plugin manifest
      .mcp.json                      ← MCP server 声明
      skills/html-report/SKILL.md     ← 流程指令（模型按需加载）
      mcp/server.mjs                  ← stdio JSON-RPC MCP server（无依赖）
```

| 文件 | 职责 |
|------|------|
| `marketplace.json` | 声明 marketplace 名称 `lumi-harness-data` 和 plugin `qdm-html-report`，指向 `./plugins/qdm-html-report` |
| `.codex-plugin/plugin.json` | Plugin 元数据：名称、版本、`skills` 路径、`mcp` 路径 |
| `.mcp.json` | 声明 MCP server：`command = "node"`，`args = ["mcp/server.mjs"]` |
| `skills/html-report/SKILL.md` | 模型流程指令：何时调哪个工具、规则、限制 |
| `mcp/server.mjs` | stdio JSON-RPC 2.0 server，5 个工具，无外部依赖，原地复用 PI 脚本 |

---

## 开发阶段使用（项目级，不碰全局）

开发阶段在仓库根目录用项目级配置，不写 `~/.codex/config.toml`，不影响其他项目。

### 前置条件

```
Node ≥ 18
qdm-metric-cli 已安装（config/harness-config.yaml 中 cli.qdm_metric_cli 指向有效二进制）
仓库根目录有 config/harness-config.yaml
```

验证：

```bash
# 确认 metric CLI 可达
cat config/harness-config.yaml | grep qdm_metric_cli
# 确认 MCP server 能启动
node plugins/qdm-html-report/mcp/server.mjs --self-test
```

### 一次性配置

`.codex/` 已在 `.gitignore` 中，不会被提交。执行以下命令创建项目级配置：

```bash
# 1. 注册 MCP server（项目级，只在当前项目生效）
mkdir -p .codex && cat > .codex/config.toml << 'EOF'
[mcp_servers.html-report]
command = "node"
args = ["plugins/qdm-html-report/mcp/server.mjs"]
cwd = "."
EOF

# 2. 放置 Skill 文件（让 Codex 发现 $html-report 技能）
mkdir -p .codex/skills/html-report
cp plugins/qdm-html-report/skills/html-report/SKILL.md .codex/skills/html-report/SKILL.md
```

验证 MCP server 已注册：

```bash
codex mcp list | grep html
# 预期输出：
# html-report   node   plugins/qdm-html-report/mcp/server.mjs   .   enabled   Unsupported
```

### 运行 Demo

以下是在 Codex CLI 中的完整交互流程，以「运营中心管理周例会报告」为例。

#### 第 1 步：启动 Codex

```bash
cd /path/to/harenss-data-feat-skill-html-report
codex
```

#### 第 2 步：输入报告需求

在 Codex 对话中输入：

```
生成运营中心管理周例会报告，分析各区域经营表现
```

模型识别到 html-report 技能，调用 `html_report_start`：

```json
// 模型调用
html_report_start({ "userQuestion": "生成运营中心管理周例会报告，分析各区域经营表现" })

// MCP server 返回
{
  "sessionId": "mcp-a44f72de",
  "sessionDir": ".harness/state/html-report/mcp-a44f72de",
  "stage": "a_config",
  "uiUrl": "http://127.0.0.1:59594",
  "message": "qdm-metric-cli ui is open. Tell the user: build cards, click 保存, then reply 继续."
}
```

模型回复用户：

> 在打开的 qdm-metric-cli ui 里搭卡，点 **保存**，然后回来回复 **继续**。

#### 第 3 步：用户配置并保存

1. 浏览器打开 `http://127.0.0.1:59594`（如果没有自动打开）
2. 在 qdm-metric-cli UI 里搭建分析卡片
3. 点击 **保存**，写出 `result.json`
4. 回到 Codex 回复：**继续**

#### 第 4 步：模型推进流水线

用户回复「继续」后，模型调用 `html_report_next`：

```json
// 模型调用
html_report_next({ "sessionId": "mcp-a44f72de" })

// MCP server 返回（B0 预检通过，第一张卡取数完成）
{
  "stage": "b2_writer",
  "sessionId": "mcp-a44f72de",
  "cardId": "section01-topic-three-one-summary",
  "cardTitle": "01 经分会课题与三个一（全品类汇总）",
  "evidence": {
    "evidencePath": ".../caption-evidence.json",
    "views": {
      "topN-bf19CustNum-manageAreaId": { "type": "topN", "metric": "bf19CustNum", ... }
    }
  },
  "message": "Data fetched. Write 1-3 short caption paragraphs..."
}
```

#### 第 5 步：模型写 caption 并提交

模型根据 evidence views 写 1-3 段短文（谁高谁低，数字必须来自 evidence），然后调用 `html_report_submit_writer`：

```json
// 模型调用
html_report_submit_writer({
  "sessionId": "mcp-a44f72de",
  "cardId": "section01-topic-three-one-summary",
  "paragraphs": [
    "粤西区客量居首，19点前客数 4,484,026；粤东区次之 3,806,785。",
    "签约新增主要集中在粤东区 3 家、粤西区 2 家。",
    "未知损耗率方面，香港区 0.0863 偏高，合肥区 0.0058 较低。"
  ],
  "pointers": [
    "/views/topN-bf19CustNum-manageAreaId/rows/0/metricValue",
    "/views/topN-bf19CustNum-manageAreaId/rows/1/metricValue"
  ]
})

// MCP server 返回
{
  "accepted": true,
  "cardId": "section01-topic-three-one-summary",
  "message": "Caption accepted. Call html_report_next to proceed."
}
```

#### 第 6 步：逐卡重复

模型继续调用 `html_report_next` 取下一张卡的数据，写 caption，提交。直到所有卡完成。

#### 第 7 步：生成 main.md

所有卡 caption 完成后，模型调用 `html_report_next`：

```json
// 模型调用
html_report_next({ "sessionId": "mcp-a44f72de" })

// MCP server 返回（compose-main.mjs 已执行）
{
  "stage": "b2_main",
  "mainPath": ".harness/state/html-report/mcp-a44f72de/analysis/main.md",
  "html": "awaiting_confirmation",
  "message": "analysis/main.md is ready. Ask the user whether to generate analysis/main.html. Call html_report_generate_html only after explicit confirmation."
}
```

流水线停在 B2_MAIN。Skill 必须询问用户是否生成 HTML；只有明确同意后才调用
`html_report_generate_html({ "sessionId": "mcp-a44f72de" })`。最终 Markdown 在
`.harness/state/html-report/mcp-a44f72de/analysis/main.md`；若导出成功，同级还有
`main.html`。

---

## 生产模式安装（Plugin 一键安装）

生产环境给其他人安装时，通过 Plugin 方式一键完成。安装后自动包含 MCP server 和 Skill，不需要手动创建 `.codex/config.toml`。

### 前置条件

- `harness-data install` 已完成（runtime workspace 已创建，包含 `agents/`、`plugins/`、`config/`、`bin/`、`wikis/`）
- 已安装 Codex CLI 或 ChatGPT 桌面 App

### 安装步骤

```bash
cd <runtime-workspace>

# 1. 注册 marketplace（指向当前 workspace）
codex plugin marketplace add .

# 2. 安装 plugin
codex plugin add qdm-html-report@lumi-harness-data
```

安装后 Plugin 自动提供：

```
qdm-html-report Plugin
  ├── .mcp.json          → 自动注册 6 个 MCP 工具（不需要手动 .codex/config.toml）
  └── skills/html-report/
        └── SKILL.md      → 自动加载流程指令（模型知道怎么走流水线）
```

### 验证

```bash
# 确认 MCP server 连上
codex mcp list | grep html
# 预期：html-report   enabled

# 确认 plugin 已安装
codex plugin list | grep qdm-html
# 预期：qdm-html-report@lumi-harness-data  installed, enabled
```

在 Codex TUI 中：
- 输入 `/mcp` 查看 html-report server 是否连上（6 个工具：`html_report_start`、`html_report_next`、`html_report_close_ui`、`html_report_submit_writer`、`html_report_generate_html`、`html_report_status`）
- 输入 `/plugins` 查看插件是否已安装
- 输入 `$html-report` 确认 Skill 可触发

### 运行 Demo

安装完成后，直接在 Codex 中输入：

```
$html-report 生成运营中心管理周例会报告，分析各区域经营表现
```

`$html-report` 触发 Skill，SKILL.md 流程指令注入，模型自动按顺序调用 MCP 工具。后续交互与开发阶段 demo 完全一致（搭卡 → 保存 → 继续 → 逐卡取数 → caption → main.md）。

---

## MCP 工具说明

| 工具 | 入参 | 用途 |
|------|------|------|
| `html_report_start` | `sessionId?`, `userQuestion` | 创建会话，打开 qdm-metric-cli ui |
| `html_report_next` | `sessionId` | B0 预检成功后关闭 UI → 逐卡取数 + evidence → 所有卡完成后 compose-main.mjs |
| `html_report_close_ui` | `sessionId` | 显式关闭 qdm-metric-cli ui，不删除报告 session 数据 |
| `html_report_submit_writer` | `sessionId`, `cardId`, `paragraphs[]`, `pointers[]` | 提交 caption，验证并写 caption.md |
| `html_report_generate_html` | `sessionId` | 用户明确确认后，将 `analysis/main.md` 导出为同级 `main.html` |
| `html_report_status` | `sessionId` | 查询当前 stage / cards 状态和只读 html 摘要 |

## Pipeline 流程

```
A_CONFIG        用户在 qdm-metric-cli ui 搭卡 → 保存 result.json
     │
     ↓ 用户回复「继续」
B0_PREFLIGHT    验证 result.json + metric CLI（不查 PI Agent）
     │
     ↓ 通过后关闭 qdm-metric-cli ui，再自动推进
B2_WRITER       逐卡：fetch-entry → prepare evidence → 宿主写 caption → submit_writer
     │
     ↓ 所有卡完成
B2_MAIN         compose-main.mjs → analysis/main.md
     │
     ↓ 用户明确同意后才调用 html_report_generate_html
可选 HTML       export-main-html.mjs → analysis/main.html（同级，非 P5 Designer）
```

`result.json` 保存本身不会关闭 UI。只有用户回复「继续」且 B0 通过后才会自动停止
本地 UI；B0 失败时保持打开以便修正。关闭的是本地服务进程，不会自动关闭浏览器标签页。

### B0 差异：App/CLI vs PI

| 检查项 | PI B0 | App/CLI B0 |
|--------|-------|------------|
| `result.json` 存在 + `status=confirmed` | ✓ | ✓ |
| Metric CLI 可达 | ✓ | ✓ |
| Session layout `phase=a` | ✓ | ✓ |
| 四个 `report-*` runtime Agent | ✓（pi-subagents list） | **不做** |

App/CLI B0 不查四个 PI Agent，因为 App 侧没有 PI 运行时。首版不派发 report-researcher / report-reviewer / report-designer。

## 限制

- 首版停在 `analysis/main.md`，不做 B25 / B3 / B4 / B5
- 不做浏览器、P5 Designer HTML、截图；B2_MAIN 可选同级 `main.html` 须用户明确确认
- 不影响现有 PI 适配（PI Skill / 扩展 / 四个 Agent 全部不变）
- `open-metric-cli-ui.mjs` 的 `--watch-pid` 已向后兼容（无参仍走 PI 进程探测）

## 相关路径速查

| 项 | 路径 |
|---|---|
| Marketplace 声明 | `.agents/plugins/marketplace.json` |
| Plugin manifest | `plugins/qdm-html-report/.codex-plugin/plugin.json` |
| MCP 声明 | `plugins/qdm-html-report/.mcp.json` |
| Skill | `plugins/qdm-html-report/skills/html-report/SKILL.md` |
| MCP server | `plugins/qdm-html-report/mcp/server.mjs` |
| PI 脚本（复用） | `.agents/pi/skills/html-report/scripts/` |
| 流水线设计 | `docs/html-report-pipeline.md` |
| 质量母表 | `docs/html-report-quality-rubric.md` |
| CI 打包 | `.github/workflows/publish-cli-release.yml` |
| Doctor 检查 | `npm/src/commands/doctor.js` |

## 流程和依赖

以下是 Codex html-report 的全部依赖复盘：

Codex html-report 完整依赖图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        宿主层（Host Model）                               │
│                     Codex CLI / ChatGPT App                               │
│                                                                           │
│  用户输入 → 模型识别 $html-report → 加载 SKILL.md → 调 MCP 工具           │
└───────────────────────────────┬─────────────────────────────────────────┘
                                 │ stdio JSON-RPC
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     ① Plugin 层（我们新写的代码）                          │
│                                                                           │
│  .agents/plugins/marketplace.json     ← Codex marketplace 声明            │
│  plugins/qdm-html-report/                                                 │
│    .codex-plugin/plugin.json          ← plugin manifest                  │
│    .mcp.json                          ← MCP server 声明                  │
│    skills/html-report/SKILL.md        ← 流程指令（模型按需加载）          │
│    mcp/server.mjs  ──────────────────────┐  5 个工具，无外部依赖          │
└──────────────────────────────────────────┼──────────────────────────────┘
                                           │ import()
                                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  ② PI 脚本层（原地复用，不搬不拆）                         │
│              .agents/pi/skills/html-report/scripts/                       │
│                                                                           │
│  ┌─ server.mjs 直接调用的 7 个脚本 ──────────────────────────────┐       │
│  │                                                                │       │
│  │  open-metric-cli-ui.mjs   建会话，开 qdm-metric-cli ui       │       │
│  │  fetch-entry.mjs          逐卡取数，写 entry.json + meta      │       │
│  │  prepare-card-caption-evidence.mjs  生成 caption evidence    │       │
│  │  submit-card-caption.mjs  验证 + 写 caption.md               │       │
│  │  compose-main.mjs         写 analysis/main.md                 │       │
│  │  export-main-html.mjs     可选同级 analysis/main.html         │       │
│  │  writer-return.mjs        路径解析 + cardId 清洗               │       │
│  └────────────────────────────────────────────────────────────────┘       │
│                                                                           │
│  ┌─ 上面 7 个脚本传递依赖的脚本 ────────────────────────────────┐       │
│  │                                                                │       │
│  │  metric-cli-executor.mjs   调 qdm-metric-cli analysis execute │       │
│  │  metric-query-contract.mjs  查询参数标准化                     │       │
│  │  metric-timeout.mjs        超时检测                            │       │
│  │  metric-retry.mjs          重试逻辑                            │       │
│  │  assemble-report.mjs       rows 提取 + Markdown 渲染           │       │
│  │  caption-dims.mjs          维度列排序                          │       │
│  │  prepare-research-evidence.mjs  evidence 操作（被 assemble 引）│       │
│  │  fetch-explore.mjs         查询补丁（被 assemble 引）          │       │
│  │  editor-plan-contract.mjs  editor 契约（被 prepare-research 引）│      │
│  └────────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
        │                                          │
        │ spawn()                                  │ import()
        ▼                                          ▼
┌───────────────────────────┐  ┌─────────────────────────────────────────┐
│  ③ 外部二进制              │  │  ④ PI 扩展（仅 authz 部分）               │
│                            │  │  .agents/pi/extensions/qdm-harness/      │
│  qdm-metric-cli             │  │                                         │
│    ├── ui  (Phase A 配置)   │  │  authz-config.mjs    读 harness-config   │
│    └── analysis execute     │  │                       解析 authz + CLI   │
│        (Phase B 取数)       │  │  lumi-envelope.mjs   Host auth 信封      │
│                            │  │                                         │
│  Node.js ≥ 18              │  │  ❌ index.ts (8000+ 行编排)  不依赖      │
│  (运行 MCP server + 脚本)   │  │  ❌ gate-control.mjs          不依赖      │
│  md2html（可选 HTML 导出）  │  │                                         │
└───────────────────────────┘  └─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        ⑤ 仓库配置 + 知识库                                │
│                                                                           │
│  config/harness-config.yaml     ← metric CLI 路径 + authz 配置            │
│  config/qdm-cli-paths.env       ← QDM_METRIC_CLI 环境变量                 │
│  config/dev-auth.blob           ← 加密 auth blob（authz.mode=on 时）      │
│  wikis/                         ← 指标/报告/维度/规则知识库               │
│  bin/data-harness-cli           ← wikis 索引构建（安装时用，流水线不直接调）│
└─────────────────────────────────────────────────────────────────────────┘

不依赖的 PI 组件

PI 运行时（完全不需要）                   PI 脚本中不用的
──────────────────────────              ──────────────────────────────
❌ pi-subagents event bridge            ❌ stage-gate.mjs (PI Gate 状态机)
❌ html_report_run_stage()               ❌ quality-scan.mjs (B4)
❌ 四个 report-* 子代理                   ❌ write-verdict.mjs (B4)
   (report-writer / researcher /         ❌ editor-plan.mjs (B2.5)
    reviewer / designer)                ❌ finalize-research-stage.mjs (B3)
❌ gate-control.mjs (Gate 文案)           ❌ finalize-editor-stage.mjs (B2.5)
❌ PI extension index.ts (8000+ 行)      ❌ compile-report-content.mjs (B5)
❌ pi-rpc-client.mjs                     ❌ compose-report.mjs (B5)
❌ check-report-agents.mjs (B0 四 Agent)  ❌ capture-report.mjs (B5)
                                         ❌ render-report.mjs (B5)
                                         ❌ finalize-design.mjs (B5)

依赖分类汇总

┌─────────────┬─────────────────────────────────────────────────┬───────────┬──────────────────────┐
│ 层          │ 组件                                            │ 数量      │ 来源                 │
├─────────────┼─────────────────────────────────────────────────┼───────────┼──────────────────────┤
│ ① Plugin 层 │ marketplace.json, plugin.json, .mcp.json, SKILL │ 5 个文件  │ 我们新写             │
│             │ .md, server.mjs                                 │           │                      │
├─────────────┼─────────────────────────────────────────────────┼───────────┼──────────────────────┤
│ ② PI 脚本层 │ 直接调用 7 个 + 传递依赖 9 个                   │ 16 个 .   │ PI 已有，原地复用    │
│             │                                                 │ mjs       │                      │
├─────────────┼─────────────────────────────────────────────────┼───────────┼──────────────────────┤
│ ③           │ qdm-metric-cli, Node.js, md2html（可选 HTML）   │ 3 个      │ 外部安装             │
│ 外部二进制  │                                                 │           │                      │
├─────────────┼─────────────────────────────────────────────────┼───────────┼──────────────────────┤
│ ④ PI 扩展   │ authz-config.mjs, lumi-envelope.mjs             │ 2 个 .mjs │ PI 已有，复用 authz  │
│             │                                                 │           │ 部分                 │
├─────────────┼─────────────────────────────────────────────────┼───────────┼──────────────────────┤
│ ⑤ 仓库配置  │ harness-config.yaml, qdm-cli-paths.env, auth    │ 4 项      │ 安装时生成           │
│             │ blob, wikis/                                    │           │                      │
└─────────────┴─────────────────────────────────────────────────┴───────────┴──────────────────────┘
```
是的，依赖了 PI 的脚本。 7 个直接调用的脚本 + 9 个传递依赖的脚本，全部来自 .agents/pi/skills/html-report/scripts/。但只用了确定性内核部分（取数、evidence、caption 验证、compose-main、export-main-html），不碰 PI 的编排层（index.ts 8000 行）、Gate 状态机、四个子代理。这就是 handoff 文档里说的「确定性内核大部分可复用，控制面必须换」。B2_MAIN 可选 HTML 与独立的 P5 Designer HTML 不是同一条路径。
