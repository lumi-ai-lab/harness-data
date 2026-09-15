# QwenPaw 报告模式 `stage template` 路径问题评审

> 用途：转发主窗口审核后续调整方案。
> 范围：本次 QwenPaw 会话中首次获取模板失败的问题。
> 本文只整理问题、根因和建议，不执行端到端查询，不修改宿主配置。

## 1. 结论

本次失败**不是 QwenPaw 插件未完整安装**，也不是 `qdm-metric-cli.exe` 或模板资源缺失。

直接原因是报告模式向 Agent 注入了旧的 CLI 调用约定：

```text
bin\data-harness-cli.exe stage template
```

该路径在当前 QwenPaw 安装布局中不存在：

```text
C:\Users\QDM\.qdm\harness-data\instance\0.1.6\bin\data-harness-cli.exe
```

当前正式插件提供的 Harness CLI 入口是：

```text
C:\Users\QDM\.copaw\plugins\qdm-harness-qwenpaw\scripts\data-harness-cli
```

但是，**只把命令路径改为 `scripts\data-harness-cli` 仍然不够**。QwenPaw 当前 Shell Hook 方案没有面向 `execute_shell_command` 的通用 PostToolUse 模板注入链；`stage template` 本身只输出阶段信号，后续模板注入还需要额外的 QwenPaw 生命周期适配。

因此建议分两层处理：

1. 当前 Shell Hook 查询链路：普通“销售情况”查询不要进入报告模板阶段。
2. 如果产品明确需要 QwenPaw 报告模式：单独补齐 QwenPaw 专用的 CLI 启动和模板注入生命周期。

## 2. 会话事实

会话编号：

```text
6fafa35b-dd62-48ef-8607-dd587afe3034
```

用户问题：

```text
查询昨天水产的销售情况
```

首次模板阶段调用：

```text
"C:\Users\QDM\.qdm\harness-data\instance\0.1.6\bin\data-harness-cli.exe" stage template
```

错误：

```text
Command failed with exit code 1.
[stderr]
系统找不到指定的路径。
```

后续指标查询能够成功，说明：

- QwenPaw 会话和 Agent 已正常运行；
- QDM requester 身份链路可用；
- Runtime MCP / Blob 查询链路本次可继续工作；
- `qdm-metric-cli.exe` 可用；
- 水产类模板相关资源至少已存在于资源目录；
- 本次失败发生在模板阶段 CLI 启动之前。

## 3. 本机安装状态

### 3.1 正式插件目录

当前插件目录：

```text
C:\Users\QDM\.copaw\plugins\qdm-harness-qwenpaw
```

已确认存在：

```text
scripts\data-harness-cli
scripts\harness-data
dist\data-harness-cli\src\main.js
dist\harness-data-installer\src\cli.js
dist\harness-runtime-node\package.json
dist\html-report-kernel\package.json
```

插件版本：

```text
0.1.6
```

本次重装前已使用正式 artifact 构建并校验，安装目录中的关键文件与 artifact 哈希一致。因此不能把本次错误归因于插件包被截断或缺少 `dist` 内容。

### 3.2 Harness 资源目录

当前资源目录：

```text
C:\Users\QDM\.qdm\harness-data\instance\0.1.6
```

已确认存在：

```text
runtimes\windows-amd64\qdm-metric-cli.exe
resources\wikis\reports\经营综合分析报告\template.md
```

安装清单中的指标 CLI 路径也正确指向：

```text
C:\Users\QDM\.qdm\harness-data\instance\0.1.6\runtimes\windows-amd64\qdm-metric-cli.exe
```

但资源目录没有：

```text
bin\data-harness-cli.exe
```

这与当前正式插件 artifact 的设计一致：Harness CLI 属于插件目录下的 Node shim，不属于 instanceRoot 的 Windows 原生二进制。

## 4. 根因分析

### 4.1 报告上下文仍注入旧路径

当前 `data-harness-cli` 上下文构造逻辑在报告模式中生成：

```text
After report playbook data collection and evidence preparation, run bin/data-harness-cli stage template.
```

该文本是跨宿主的通用指令，假定 Agent 当前工作目录下存在：

```text
bin/data-harness-cli
```

在 QwenPaw 中，Agent 工作区和 Harness 资源目录并不等同于插件目录，且正式 QwenPaw artifact 没有把 CLI shim 复制到工作区 `bin` 目录。因此 Windows 下最终被解析为不存在的：

```text
<instanceRoot>\bin\data-harness-cli.exe
```

### 4.2 当前插件入口和旧调用约定不一致

构建脚本生成的是：

```text
<pluginRoot>\scripts\data-harness-cli
```

这是一个无扩展名 Node shim，负责加载：

```text
<pluginRoot>\dist\data-harness-cli\src\main.js
```

Windows 下不能假设无扩展名 Node shim 可以被 `subprocess.run([path], shell=False)` 直接作为原生可执行文件启动，需要使用：

```text
node.exe <pluginRoot>\scripts\data-harness-cli stage template
```

工作区已经有 `qdm_subprocess.py` 的 `cli_command()`，可用于统一构造这种跨平台启动命令。

### 4.3 `stage template` 不是完整的模板注入动作

`stage template` 的实现只输出阶段信号：

```text
QDM_STAGE_TEMPLATE_SIGNAL emitted
```

它不会把模板正文直接输出给 Agent。模板正文需要由后续 PostToolUse / report lifecycle 根据当前 session state 进行注入。

当前仓库的通用模板识别和注入逻辑主要位于：

```text
packages\data-harness-cli\src\lib\posttool\hook.js
packages\data-harness-cli\src\lib\posttool\qwenpaw.js
```

但 QwenPaw 当前插件的公开查询路径是：

```text
execute_shell_command
  -> QwenPaw Shell middleware
  -> qdm-metric-cli analysis execute
```

当前 Shell middleware 只处理：

```text
qdm-metric-cli analysis execute
qdm-metric-cli auth describe
```

对普通 Shell 命令直接放行，不负责 `stage template` 的后置模板注入。

同时，QwenPaw 插件中的 `qdm_report_lifecycle.py` 目前是围绕 `qdm_query` 成功后的 `posttool --format qwenpaw-hook` 设计的；Shell Hook 模式下 `qdm_query` 不作为公共查询入口，不能自然覆盖本次 `execute_shell_command` 场景。

所以本次问题包含两个层次：

1. **已发生的启动问题**：命令引用了不存在的 `instance\bin` 路径。
2. **潜在的生命周期问题**：即使命令改为插件 `scripts` 入口，也必须确认 QwenPaw 是否会在命令成功后触发模板注入。

## 5. 是否属于 Windows 兼容问题

属于 Windows 表现出来的兼容问题，但根因不是 `.exe` 后缀本身。

跨平台共同问题是：

```text
通用报告指令使用 bin/data-harness-cli
当前 QwenPaw artifact 使用 pluginRoot/scripts/data-harness-cli
```

Windows 额外暴露了 Node shim 的启动差异：

```text
Windows：需要 node.exe 显式启动无扩展名 shim
Linux：通常可以直接执行带执行权限的无扩展名 shim
```

因此 Linux 不能简单视为天然不受影响。若 Linux 报告流程仍调用不存在的 `bin/data-harness-cli`，同样会失败；只是不会首先表现为 `.exe` 路径问题。

## 6. 建议调整方案

### 6.1 方案 A：当前 Shell Hook 方案的最小调整，建议优先采用

当前 QwenPaw Shell Hook 方案应将普通指标查询和报告模板流程明确分开。

建议：

1. `single`、`multi_single` 和普通自由查询模式继续禁止：
   ```text
   stage template
   inject-template
   ```
2. 对“查询销售情况”这类没有明确要求生成报告的请求，避免被错误提升为 `report` 模式。
3. QwenPaw Skill 继续明确：
   ```text
   Report/template lifecycle is not part of the public QwenPaw Shell query path.
   ```
4. 报告模式只有在用户明确提出“生成报告、经营分析报告、综合分析报告”等意图时才进入。
5. 在 QwenPaw 尚未实现完整报告生命周期之前，报告模式不应要求 Agent 执行 `stage template`。

这一方案改动最小，也与当前插件已经落地的 Shell Hook 边界一致。它不会影响：

- `qdm_scope_summary`；
- `qdm-metric-cli analysis execute`；
- Runtime MCP Blob 获取；
- 当前用户权限过滤；
- 普通销售额、毛利率等指标查询。

### 6.2 方案 B：如果必须支持 QwenPaw 报告模式

如果生产需求要求 QwenPaw 也能生成带模板的报告，则需要做完整适配，不能只改一行路径。

#### B1. 统一 CLI 入口解析

复用或扩展：

```text
.agents/qwenpaw/qdm_subprocess.py
```

统一得到实际启动命令：

```text
Linux：
<pluginRoot>/scripts/data-harness-cli stage template

Windows：
node.exe <pluginRoot>\scripts\data-harness-cli stage template
```

CLI 路径必须来自受信 Root Context 的 `pluginRoot`，不能由用户输入拼接，也不能回到 `instanceRoot\bin`。

#### B2. 调整 QwenPaw 报告指令

不能继续向 QwenPaw Agent 注入不具备执行条件的：

```text
bin/data-harness-cli stage template
```

可选实现：

1. 由 QwenPaw 上下文适配层注入宿主可执行的完整命令；
2. 更推荐增加插件拥有的“报告阶段”工具，由插件内部调用 CLI，不让 Agent 自己拼接插件路径。

若仍让 Agent 使用 `execute_shell_command`，必须同时更新模板阶段识别逻辑，使其能识别：

```text
node "<pluginRoot>\scripts\data-harness-cli" stage template
```

否则命令虽能运行，PostToolUse 识别器仍可能把它当成普通 Shell 命令。

#### B3. 补齐 QwenPaw 模板注入生命周期

需要明确以下链路：

```text
QwenPaw report context
  -> report data collection
  -> stage template
  -> QwenPaw-specific post-execution handling
  -> posttool --format qwenpaw-hook
  -> current session template injection
  -> Agent generates report
```

如果 QwenPaw 宿主没有可用的 PostToolUse 扩展点，应改为插件自有的报告工具或报告编排入口，不能假设通用 Claude/WorkBuddy Hook 会自动执行。

#### B4. 保持安全边界

报告生命周期调整不能改变 QDM 查询授权边界：

- `qdm-metric-cli analysis execute` 仍由 Shell Hook 注入当前 requester 的授权参数；
- Agent 不得手写 `--data-auth`、`--auth-blob` 或 `--auth-json`；
- `stage template` 不得触发 Blob 获取，也不得绕过 Shell Hook；
- 模板注入只能使用当前 session state 选中的模板；
- 模板路径继续执行允许目录校验；
- CLI 启动继续使用 `shell=False`；
- 日志不得记录 Blob、Token 或完整敏感命令。

## 7. 建议修改文件

### 7.1 方案 A 的最小修改

优先检查和调整：

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\context\build.js
```

重点：

- 避免普通 QwenPaw Shell 查询进入报告模板阶段；
- 为 QwenPaw 与其他宿主区分报告模式指令；
- 不再对 QwenPaw Shell Hook 无条件注入 `bin/data-harness-cli stage template`。

必要时同步：

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\qdm_harness_context.py
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\skills\qdm-harness\SKILL.md
```

### 7.2 方案 B 的扩展修改

除上述文件外，还需要评估：

```text
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\qdm_subprocess.py
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\.agents\qwenpaw\qdm_report_lifecycle.py
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\posttool\hook.js
D:\Repos\harness-data-qwenpaw-qdm-shell-hook-query\packages\data-harness-cli\src\lib\posttool\qwenpaw.js
```

不建议把修复限定为新增：

```text
<instanceRoot>\bin\data-harness-cli.exe
```

也不建议只复制一个 `.cmd` 文件作为唯一修复。这样会维护第二套入口，并且不能自动解决 QwenPaw 的模板后置注入问题。

## 8. 测试建议

### 8.1 静态/单元测试

至少覆盖：

1. QwenPaw `multi_single` 查询不会生成 `stage template` 指令；
2. 普通“查询销售情况”不会误进入报告模式；
3. 明确“生成经营分析报告”时，报告模式行为符合预期；
4. Windows 解析到 `scripts\data-harness-cli` shim 时使用 `node.exe`；
5. Linux 继续直接执行无扩展名 shim；
6. `instance\bin\data-harness-cli.exe` 缺失时不会误判为插件未安装；
7. 若启用报告模式，Node shim 命令能被模板阶段识别器正确识别；
8. 模板注入仍绑定当前 session state，不读取其他会话模板；
9. 普通指标查询仍由 Shell Hook 完成 Blob 注入和授权改写。

### 8.2 人工端到端验证

按用户既定安排，代码调整完成后再由用户手动验证：

1. 重启 QwenPaw；
2. 在会话 `6fafa35b-dd62-48ef-8607-dd587afe3034` 中发送：
   ```text
   查询昨天水产的销售情况
   ```
3. 确认普通查询不再无条件调用 `stage template`；
4. 确认指标查询成功；
5. 如验证报告模式，再单独发送明确的报告请求；
6. 确认报告模式的模板注入结果，而不是只确认 CLI 命令退出码为 0。

## 9. 主窗口审核要点

请重点确认：

- [ ] 当前产品是否要求 QwenPaw Shell Hook 支持报告模板生命周期；
- [ ] 如果不要求，是否将普通“销售情况”查询固定为 `multi_single` 或普通查询模式；
- [ ] 如果要求，是否接受补充 QwenPaw 专用 PostToolUse/报告工具链；
- [ ] 是否同意统一使用 `pluginRoot/scripts/data-harness-cli`，不再依赖 `instanceRoot/bin`；
- [ ] Windows 是否采用 `node.exe` 显式启动 Node shim；
- [ ] 是否同步扩展模板阶段命令识别器；
- [ ] 是否保持 `qdm_scope_summary` 默认开启；
- [ ] 是否保持普通 QDM 查询的 Shell Hook 授权边界不变。

## 10. 推荐决策

建议主窗口先采用**方案 A**：

> 当前 QwenPaw Shell Hook 只承担授权 QDM 指标查询；普通销售情况查询不进入模板报告生命周期。

如果后续确定需要 QwenPaw 生成报告，再按**方案 B**单独设计和实施。届时统一使用插件根目录下的 `scripts/data-harness-cli`，并同时解决 Windows Node shim 启动和 QwenPaw 模板后置注入两个问题。
