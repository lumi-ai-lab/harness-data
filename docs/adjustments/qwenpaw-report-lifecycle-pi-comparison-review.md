# QwenPaw 报告生命周期与 pi agent 对比调整建议

> 用途：转发主窗口审核，并据此决定后续 QwenPaw 报告流程调整。
>
> 范围：对比 QwenPaw 当前“报告模板注入”流程与 pi agent 的 `html-report`
> 报告流程，整理当前问题、建议调整内容和验收边界。
>
> 本文不执行端到端验证，不直接修改宿主机配置。端到端验证由后续人工验收执行。

## 1. 结论

QwenPaw 与 pi agent **类似的是生命周期设计思想，不是完整实现流程**。

两者都需要：

- 将当前会话与报告状态绑定；
- 由可信运行时选择模板，而不是由 Agent 任意指定模板路径；
- 将状态写入独立的 `stateRoot`；
- 在数据查询和报告模板处理之间保持授权边界；
- 通过明确的阶段入口推进报告流程。

但两者的产品能力不同：

- **QwenPaw** 当前是轻量的“会话状态 + 报告模板注入”流程，最终主要在对话中输出报告。
- **pi agent** 是完整的多阶段报告编排流程，包含 Stage Gate、Report SubAgent、逐卡取数、证据、审核和报告产物。

因此，本次调整应补齐 QwenPaw 自身的生命周期一致性，不应直接复制 pi agent 的
Stage Runner、多个 Report Agent 或完整 `analysis/main.md` 编排。

## 2. 当前流程对比

### 2.1 QwenPaw 当前流程

```text
用户问题
  -> context --format qwenpaw-hook
  -> 识别 report 模式并选择 playbook/template
  -> 保存当前 session state
  -> Agent 按 playbook 执行 qdm-metric-cli 查询
  -> 调用 qdm_report_stage
  -> 插件内部执行 stage template
  -> posttool --format qwenpaw-hook
  -> 读取当前 session state 并注入模板
  -> Agent 生成最终回复
```

当前实现依据：

- `.agents/qwenpaw/qdm_report_lifecycle.py`：执行 `stage template` 和
  `posttool --format qwenpaw-hook`；
- `packages/data-harness-cli/src/lib/context/build.js`：向 report 模式注入
  `qdm_report_stage` 调用约束；
- `packages/data-harness-cli/src/lib/posttool/qwenpaw.js`：校验当前会话、
  report 模式、模板和安全参数；
- `packages/data-harness-cli/src/lib/sessionstate.js`：持久化当前会话状态。

### 2.2 pi agent 当前流程

```text
A_CONFIG
  -> 用户在 qdm-metric-cli UI 中配置并保存 result.json
  -> B0_PREFLIGHT
  -> B2_WRITER
  -> Report Writer 逐卡取数并生成 caption/evidence
  -> B2_MAIN 生成 analysis/main.md
  -> 可选 B25/B3/B4/B5
  -> Gate 和结构化产物验收
```

pi agent 的关键特征：

- `html_report_start` 创建并绑定 Report Session；
- Stage Gate 管理阶段、attempt 和人工确认；
- `html_report_run_stage()` 是父 Agent 使用的无参阶段入口；
- Report Writer、Researcher、Reviewer、Designer 分工执行；
- Stage Runner 负责调度、结构化返回、产物验收和失败处理；
- 状态和报告产物均由运行时持久化管理。

主要参考：

- `.agents/pi/skills/html-report/SKILL.md`
- `docs/plugin-html-report.md`
- `plugins/harness-data/mcp/server.mjs`

## 3. 主要问题

### 3.1 QwenPaw Root Context 的 `stateRoot` 需要保持可用

QwenPaw 的报告流程依赖以下连续操作：

```text
context -> 保存 session state -> qdm_report_stage -> posttool -> 读取 session state
```

如果 QwenPaw 的持久化 Root Context 在带 workspace 的调用中丢失
`stateRoot`，则可能出现：

- `context` 阶段看似成功，但状态无法写入预期目录；
- `qdm_report_stage` 无法读取当前 session state；
- `posttool` 无法确认当前模板；
- 最终返回 `session_state_unavailable`、`missing_session_state` 或
  `no_selected_template`；
- 同一会话中 context、stage、posttool 使用了不同的状态根目录。

需要特别注意：`stateRoot` 必须是由可信 Root Context 解析出的路径，不能由
Agent 或用户参数拼接。该路径仍应满足现有 `dataRoot`、workspace 和允许目录
关系校验。

建议主窗口确认：

- QwenPaw 持久化 Root Context 是否至少保留已安装 workspace 对应的 `stateRoot`；
- context、stage、posttool 是否使用同一份 Root Context；
- workspace 变化时是否重新解析并校验 `stateRoot`；
- 无有效 `stateRoot` 时是否 fail-closed，而不是临时创建不可追踪状态。

### 3.2 `qdm_report_stage` 的参数边界仍需收紧

QwenPaw 当前工具允许携带：

```text
report_name
report_module
```

如果这些值来自 Agent 自行推断，可能造成：

- 报告名称与 context 阶段选择的报告不一致；
- 报告模块路径与插件内部配置不一致；
- stage 已执行，但 posttool 无法在当前状态中找到匹配模块；
- 报告流程出现“命令成功、模板未注入”的假成功。

pi agent 的对应原则是：父 Agent 只调用当前 Gate 注入的无参
`html_report_run_stage()`，不自行传递阶段、任务、路径或调度参数。

QwenPaw 应采用同样的约束思想：

1. 默认调用 `qdm_report_stage` 时不传 `report_name/report_module`；
2. 报告名称、模块和模板由当前 session state 及插件内部配置决定；
3. 只有在插件内部已验证参数与配置完全一致时，才允许兼容性地接受这两个参数；
4. 不允许 Agent 通过参数指定任意文件路径、模板路径或模块目录；
5. 参数不匹配时应明确失败，不应静默切换到其他报告模板。

### 3.3 当前 QwenPaw 不是 pi 的完整 Stage Runner

QwenPaw 当前 `qdm_report_stage` 的本质是：

```text
stage template
  -> 产生阶段信号
  -> posttool 根据 session state 注入模板
```

它不等同于 pi 的：

```text
Stage Runner
  -> 调度 Report Agent
  -> 读取结构化结果
  -> 验收持久化产物
  -> 推进 Gate
```

因此不能因为两者都存在“stage”概念，就要求 QwenPaw 具备 pi 的全部能力。
当前应先保证 QwenPaw 的最小生命周期闭环可用，再决定是否需要扩展为完整报告
编排器。

### 3.4 缺少协议级生命周期验证

当前需要补充一条明确的协议级验证链路：

```text
context --format qwenpaw-hook
  -> stage template
  -> posttool --format qwenpaw-hook
```

该测试不能只断言每个命令单独退出码为 0，还应确认：

- context 返回有效的 QwenPaw Hook envelope；
- 当前 report session state 已创建；
- `stateRoot` 与 workspace 绑定正确；
- `stage template` 使用同一份上下文；
- posttool 能读取同一 session state；
- 最终诊断码为 `template_injected`；
- `stateRoot/business-report` 下生成或更新当前会话状态；
- 不会读取其他 session 的模板或状态。

## 4. 建议调整内容

### 4.1 必须调整：保留并统一 `stateRoot`

建议调整 QwenPaw Root Context 和调用链，确保：

```text
context、stage、posttool
```

均使用同一个、经过校验的 `stateRoot`。

建议实现原则：

- 持久化 Root Context 保留已安装 workspace 对应的 `stateRoot`；
- invocation context 不应在正常报告调用中无条件删除 `stateRoot`；
- 若 workspace 变化，重新计算并校验对应 `stateRoot`；
- `stateRoot` 必须位于受信 `dataRoot` 下；
- 缺少 `stateRoot` 时返回明确的上下文不可用错误；
- 不允许回退到当前工作目录、临时目录或插件缓存目录作为隐式状态根。

这项调整是 QwenPaw 报告流程能够跨工具调用保持状态的基础。

### 4.2 必须调整：报告工具默认无参数

在 QwenPaw Skill 文档中明确：

```text
完成报告数据采集后，只调用 qdm_report_stage。
默认不传 report_name、report_module、模板路径或阶段参数。
报告名称、模块和模板由当前 session state 与插件内部配置决定。
```

兼容参数仅在以下条件同时满足时允许：

- 参数由可信插件逻辑产生，而非 Agent 自行拼接；
- `report_name` 是插件内部已注册的报告名称；
- `report_module` 属于该报告的允许模块集合；
- 参数与当前 session state 的选择一致；
- 参数不会扩大模板文件或工作区访问范围。

### 4.3 必须调整：强化 QwenPaw Skill 的流程边界

QwenPaw Skill 应明确区分普通查询与报告查询：

普通查询：

- 使用 `execute_shell_command` 执行 QDM 指标查询；
- 不调用 `qdm_report_stage`；
- 不调用 `stage template` 或 `inject-template`；
- 不读取或猜测模板文件；
- 不自行处理报告状态。

明确报告请求：

- 使用当前 report playbook 完成数据采集；
- 仅调用插件提供的 `qdm_report_stage`；
- 等待工具返回当前模板注入结果；
- 只使用当前 session state 选中的模板生成报告。

推荐写入 Skill 的约束文本：

```text
QwenPaw report flow is session-bound. After report data collection, call only
the plugin-owned qdm_report_stage tool. Do not pass report_name,
report_module, template paths, stage names, or workspace paths by default.
The plugin resolves the report and template from the current session state.
Never call data-harness-cli stage template or inject-template through the host
shell, and never read or guess template files directly.
```

### 4.4 必须调整：增加协议级测试

建议新增或扩展 QwenPaw 生命周期测试，至少覆盖：

1. report prompt 通过 `context --format qwenpaw-hook` 选择模板；
2. context 写入当前 session state；
3. `stage template` 不接受额外参数；
4. `posttool --format qwenpaw-hook` 读取同一 session；
5. 最终返回 `diagnostic_code=template_injected`；
6. `stateRoot/business-report/<session>.json` 存在且 session ID 一致；
7. 缺少 `stateRoot` 时 fail-closed；
8. 使用错误 workspace 或错误 session 时不能注入模板；
9. 无 selected template 时不返回成功注入；
10. `report_name/report_module` 不传时仍能完成正常报告阶段；
11. 参数与当前 session state 不一致时拒绝；
12. 同一流程不会读取其他会话的状态或模板。

建议协议测试使用受控临时目录和固定 fixture，不执行真实用户数据查询。

### 4.5 保持不变：授权与权限工具边界

报告生命周期调整不应改变 QDM 数据授权链路：

- `qdm_scope_summary` 保留并默认开启；
- `qdm_scope_summary` 是用户查询当前权限范围的独立工具；
- 普通指标查询的 Blob 获取仍由 Shell Hook 根据当前 requester 完成；
- Agent 不得手写 `--data-auth`、`--auth-blob` 或 `--auth-json`；
- `qdm_report_stage` 不负责获取 Blob，也不得绕过 Shell Hook；
- 报告模板注入不应扩大当前用户的数据权限；
- 日志不得记录 Blob、Token 或完整敏感命令。

`qdm_scope_summary` 与报告模板生命周期是两个独立问题，不应因为报告流程
调整而关闭权限摘要工具。

### 4.6 必须调整：限定跨 Agent 影响范围

本次方案如果只调整 QwenPaw 适配层，其他 Agent 的普通查询和报告流程不应发生
业务变化。但以下文件属于共享运行时，直接修改可能影响 Codex、pi agent、
WorkBuddy 或 Claude：

```text
packages/data-harness-cli/src/lib/root-context.js
packages/data-harness-cli/src/lib/sessionstate.js
packages/data-harness-cli/src/lib/context/build.js
packages/data-harness-cli/src/lib/context/hook.js
packages/data-harness-cli/src/lib/posttool/hook.js
plugins/harness-data/scripts/context-store.mjs
```

建议采用以下隔离原则：

1. QwenPaw 专属规则优先放在 `.agents/qwenpaw/` 下的适配代码和
   `plugins/harness-data/skills/` 中；
2. `posttool --format qwenpaw-hook` 只处理 QwenPaw 协议，不改变
   `codex-hook`、`agent-hook`、`claude-hook` 或 `workbuddy-hook` 的返回结构；
3. 如果共享 `build.js` 必须调整，应按 `host/surface` 做显式分支，仅对
   `qwenpaw` 注入 QwenPaw 的 `qdm_report_stage` 约束；
4. `stateRoot` 的修复必须保持按 workspace 和 host 隔离，不能统一替换成
   QwenPaw 专用目录；
5. 不改变 pi 的 `html_report_run_stage()`、Stage Runner、Gate 和
   `html-report` session 目录规则；
6. 不因 QwenPaw 报告流程调整而改变其他 Agent 的工具注册、权限注入或模板
   注入行为。

因此，“保留 QwenPaw 的 `stateRoot`”并不等于让所有 Agent 共用同一份报告
状态；正确做法是让每个宿主继续使用自己的已校验状态根目录，并按 workspace、
session 和协议格式隔离。

## 5. 与 pi agent 的对应关系

| pi agent 机制 | QwenPaw 对应调整 | 是否直接复制 |
| --- | --- | --- |
| Report Session 持久化 | 保留 QwenPaw 当前 session state 和 `stateRoot` | 否，只借鉴会话绑定 |
| Stage Gate | 增加 `context -> stage -> posttool` 协议闭环测试 | 否，不引入完整 Gate |
| 无参 `html_report_run_stage()` | `qdm_report_stage` 默认无参数调用 | 是，借鉴调用约束 |
| Stage Runner | QwenPaw 插件内部完成模板阶段和注入 | 否，不引入多 Agent 编排 |
| Report Writer/Researcher/Reviewer/Designer | 当前 QwenPaw Agent 继续负责最终对话输出 | 否 |
| `analysis/main.md` 等产物验收 | 先验收模板注入和会话状态 | 否，除非后续明确需要文件报告 |

## 6. 建议修改文件

### 6.1 QwenPaw 优先调整文件

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\qdm_report_lifecycle.py
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\qdm_harness_context.py
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\plugin.py
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\skills\qdm-harness\SKILL.md
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\plugins\harness-data\skills\html-report\SKILL.md
```

### 6.2 共享文件：仅在必要时调整

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\test\root-context.test.js
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\plugins\harness-data\scripts\context-store.mjs
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\root-context.js
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\sessionstate.js
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\context\build.js
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\context\hook.js
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\posttool\hook.js
```

共享文件调整前必须先说明：

- 为什么 QwenPaw 适配层无法独立完成；
- 变更对各宿主的具体影响；
- 如何通过 host/surface 分支保持原有行为；
- 如何增加其他 Agent 的回归测试。

### 6.3 应补充测试

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\test\posttool.test.js
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\test\template-selection.test.js
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\tests\test_golden_path.py
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\plugins\harness-data\mcp\host-adapter.test.mjs
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\plugins\harness-data\mcp\server.test.mjs
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\pi\extensions\qdm-harness\test\extension.test.mjs
```

实际修改前应先确认这些文件中的现有未提交改动，避免覆盖主窗口或其他开发
流程已经完成的调整。

## 7. 不建议的调整

当前不建议：

- 将 QwenPaw 改造成 pi agent 的完整多阶段报告系统；
- 直接引入 pi 的 Stage Gate、Report SubAgent 和 attempt reservation；
- 直接复制 pi 的 `.harness/state/html-report` 目录结构；
- 让 Agent 自行拼接插件路径、模板路径或报告模块路径；
- 通过 `instanceRoot/bin/data-harness-cli` 增加第二套 CLI 入口；
- 仅修改命令路径而不验证后续 posttool 模板注入；
- 直接修改共享 Root Context 或通用 PostToolUse 逻辑而不增加其他 Agent
  的回归测试；
- 将 QwenPaw 的 `stateRoot`、session ID 或报告状态与 pi/WorkBuddy/Claude
  的状态目录强行合并；
- 因为报告流程问题关闭 `qdm_scope_summary`；
- 让报告阶段工具直接获取 Blob 或修改授权参数。

如果未来明确要求 QwenPaw 输出类似 pi 的
`analysis/main.md`、evidence、review 或 HTML 产物，应另立设计和实施方案。

## 8. 验收标准

### 8.1 静态与协议验收

- [ ] QwenPaw report context 能产生稳定且可验证的 session state。
- [ ] context、stage、posttool 使用同一个 `stateRoot`。
- [ ] `stateRoot` 位于受信 `dataRoot` 下。
- [ ] `qdm_report_stage` 默认无 `report_name/report_module` 参数。
- [ ] 参数与当前 session state 不一致时 fail-closed。
- [ ] 协议链路最终返回 `template_injected`。
- [ ] 普通查询不调用报告模板阶段。
- [ ] `qdm_scope_summary` 保留且默认开启。
- [ ] Blob 获取仍由当前 requester 的 Shell Hook 授权链路完成。
- [ ] 测试不会读取其他 session 的模板或状态。

### 8.2 人工端到端验收

按既定安排，代码和协议测试完成后再由用户手动执行：

1. 重启 QwenPaw；
2. 发起普通指标查询，确认不进入报告模板阶段；
3. 发起明确的报告请求；
4. 确认报告查询、模板选择和最终模板注入均成功；
5. 确认权限摘要工具仍可用；
6. 确认无权限、错误 session、错误模块等异常仍然拒绝。

## 9. 主窗口审核清单

- [ ] 是否确认 QwenPaw 只需要轻量模板注入，不需要复制 pi 的完整报告编排？
- [ ] 是否同意保留 QwenPaw report session 对应的 `stateRoot`？
- [ ] 是否同意 `qdm_report_stage` 默认无参数？
- [ ] 是否允许仅在插件内部配置完全匹配时兼容 `report_name/report_module`？
- [ ] 是否将 `context -> stage -> posttool` 作为协议级回归测试？
- [ ] 是否保持 `qdm_scope_summary` 默认开启？
- [ ] 是否确认报告阶段不参与 Blob 获取和授权改写？
- [ ] 是否接受普通查询与报告模板流程继续分离？
- [ ] 是否确认暂不引入 pi 的 Stage Gate、SubAgent 和 `analysis/main.md` 产物编排？
- [ ] 是否同意 QwenPaw 优先修改适配层，避免直接修改共享运行时？
- [ ] 如需修改共享文件，是否已补充 Codex、pi、WorkBuddy/Claude 的回归测试？
- [ ] 是否确认其他 Agent 的工具注册、授权注入和报告状态目录保持不变？

## 10. 推荐决策

建议主窗口采用以下最小调整集合：

1. 保证 QwenPaw Root Context 在有效 workspace 下保留可用的 `stateRoot`；
2. 让 context、stage、posttool 始终使用同一会话和同一状态根目录；
3. 在 QwenPaw Skill 中规定 `qdm_report_stage` 默认无参数调用；
4. 增加 `context -> stage -> posttool` 协议级测试；
5. 保持普通 Shell 查询、`qdm_scope_summary` 和授权 Blob 链路不变；
6. 优先在 QwenPaw 适配层落地，避免不必要的共享层修改；
7. 共享层如确需修改，必须按 host/surface 隔离并补齐其他 Agent 回归测试；
8. 暂不把 QwenPaw 扩展为 pi agent 的完整报告流水线。

按上述边界实施后，该方案与 pi agent 在生命周期原则上保持一致，但不会改变
其他 Agent 的普通查询、权限工具、授权注入或完整报告流水线行为，适合作为后续
实际施工的审核基线。
