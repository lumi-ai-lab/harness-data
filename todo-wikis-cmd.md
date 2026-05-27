# Wikis 命令实施 Todo

## 阶段 1：Wiki 文档解析与路径推导

- [ ] 新增 Wiki 文档模型，覆盖 `id`、`path`、`kind`、`domain`、`title`、`name`、`label`、`aliases`、`covers` 等字段。
- [ ] 实现逻辑路径规范：索引和检查内部统一使用 `spec/...`、`playbooks/...`、`templates/...` 逻辑路径。
- [ ] 实现路径生成 ID：逻辑路径去掉 `.md` 后缀，例如 `spec/idx/business-manager/s-sale-amt`。
- [ ] 实现 `kind` 路径推导：`spec`、`spec_index`、`playbook`、`playbook_index`、`template`、`template_index`。
- [ ] 实现 `domain` 路径推导：相对于知识类型根目录的业务路径，例如 `idx/business-manager`。
- [ ] 实现 Markdown 一级标题解析。
- [ ] 实现一级标题规则：每个 Markdown 必须有且只有一个 H1。
- [ ] 实现 frontmatter 解析，仅识别允许字段：`name`、`label`、`aliases`、`covers`。
- [ ] 实现未知或废弃 frontmatter 字段检测：`id`、`kind`、`domain`、`title`、`tags`、`match.keywords`、`context.default_files`、`children.path`、`template` 等都应报错。
- [ ] 实现普通 spec 识别：`spec/**` 下非 `index.md`、非 `c-*.md` 文件。
- [ ] 实现 `c-` 公共或概念 spec 识别。
- [ ] 实现普通 playbook 识别：存在同路径同名 spec 的 `playbooks/**` 非 `index.md` 文件。
- [ ] 实现组合 playbook 识别：不存在同路径同名 spec 的 `playbooks/**` 非 `index.md` 文件。
- [ ] 实现 template 普通报告文档识别：`templates/**` 非 `index.md` 文件。
- [ ] 实现同路径推导：spec -> playbook、playbook -> template、template -> playbook。
- [ ] 为路径推导、文档类型识别、标题解析、frontmatter 解析补充单元测试。

## 阶段 2：`wikis check-*`

- [ ] 新增 `data-harness-cli wikis` 子命令入口。
- [ ] 删除旧顶层命令兼容设计，不保留长期 alias：`build-index`、`validate` 等旧命名后续移除。
- [ ] 实现统一检查错误模型：`check`、`path`、`code`、`message`，可选 `target`、`value`、`other`。
- [ ] 实现检查命令通用输出：文本输出和 `--json` 输出。
- [ ] 实现检查命令 exit code：`0` 无错误，`1` 有错误，`2` 参数或运行时异常。
- [ ] 实现错误输出上限：单项默认 100 条，`check-all` 默认 500 条。
- [ ] 实现 `--max-errors N`。
- [ ] 实现 `--fail-fast`。
- [ ] 实现 `truncated=true`、总错误数、展示错误数、隐藏错误数输出。
- [ ] 固化第一批错误码：`missing_index_md`、`missing_h1`、`multiple_h1`、`missing_frontmatter`、`unknown_frontmatter_field`、`missing_required_field`、`invalid_frontmatter_type`、`missing_name`、`missing_label`、`duplicate_alias`、`duplicate_recall_value`、`alias_not_allowed`、`missing_covers`、`invalid_cover_path`、`missing_cover_target`、`invalid_covers_type`、`missing_playbook`、`missing_template`、`orphan_template`。

### `check-index-md`

- [ ] 实现 `data-harness-cli wikis check-index-md`。
- [ ] 检查 `spec`、`playbooks`、`templates` 每层目录必须存在 `index.md`。
- [ ] 缺失 `index.md` 报 `missing_index_md`。
- [ ] 不检查 `routing` 目录。

### `check-titles`

- [ ] 实现 `data-harness-cli wikis check-titles`。
- [ ] 检查每个 Markdown 是否存在 H1。
- [ ] 缺失 H1 报 `missing_h1`。
- [ ] 多个 H1 报 `multiple_h1`。

### `check-frontmatter`

- [ ] 实现 `data-harness-cli wikis check-frontmatter`。
- [ ] 检查普通 spec 必须有 frontmatter。
- [ ] 检查普通 spec frontmatter 必须包含 `name` 和 `label`。
- [ ] 检查组合 playbook 必须有 frontmatter。
- [ ] 检查组合 playbook frontmatter 必须包含 `aliases` 和 `covers`。
- [ ] 允许 `c-` spec、`index.md`、普通 playbook、template 没有 frontmatter。
- [ ] 检查 frontmatter 只允许 `name`、`label`、`aliases`、`covers`。
- [ ] 未知字段报 `unknown_frontmatter_field`。
- [ ] 必需 frontmatter 缺失报 `missing_frontmatter`。
- [ ] 必需字段缺失报 `missing_required_field`，或使用更具体的 `missing_name` / `missing_label` / `missing_covers`。
- [ ] 类型错误报 `invalid_frontmatter_type` 或 `invalid_covers_type`。

### `check-aliases`

- [ ] 实现 `data-harness-cli wikis check-aliases`。
- [ ] 检查普通 spec 必须有 `name`。
- [ ] 检查普通 spec 必须有 `label`。
- [ ] 检查普通 spec 的 `aliases` 可选。
- [ ] 检查 `c-` spec 的 `name`、`label`、`aliases` 可选。
- [ ] 检查普通单指标 playbook 不允许维护 `aliases`。
- [ ] 检查组合 playbook 必须维护 `aliases`。
- [ ] 检查单文档内 `aliases` 去重，重复报 `duplicate_alias`。
- [ ] 构建全局召回值集合：普通 spec 的 `name`、`label`、`aliases`，`c-` spec 已维护的召回字段，组合 playbook 的 `aliases`。
- [ ] 检查召回值全局唯一，冲突报 `duplicate_recall_value`。
- [ ] 普通 playbook 维护 `aliases` 报 `alias_not_allowed`。

### `check-covers`

- [ ] 实现 `data-harness-cli wikis check-covers`。
- [ ] 检查组合 playbook 必须维护 `covers`。
- [ ] 检查普通单指标 playbook 不需要 `covers`。
- [ ] 检查 `covers` 必须是数组。
- [ ] 检查 `covers` 只能引用 `spec/...` 逻辑路径。
- [ ] 检查 `covers` 引用的 spec 文件必须存在。
- [ ] 允许 `covers` 引用 `c-` 开头的公共或概念 spec。
- [ ] 缺失 `covers` 报 `missing_covers`。
- [ ] 非 spec 逻辑路径报 `invalid_cover_path`。
- [ ] 引用不存在报 `missing_cover_target`。
- [ ] 类型错误报 `invalid_covers_type`。

### `check-links`

- [ ] 实现 `data-harness-cli wikis check-links`。
- [ ] 检查普通 spec 必须有同路径同名 playbook。
- [ ] `c-` spec 不强制要求 playbook。
- [ ] `index.md` 不参与 spec -> playbook 检查。
- [ ] 检查每个 playbook 非 `index.md` 必须有同路径同名 template。
- [ ] 检查每个普通 template 非 `index.md` 必须有同路径同名 playbook。
- [ ] 普通 spec 缺 playbook 报 `missing_playbook`。
- [ ] playbook 缺 template 报 `missing_template`。
- [ ] template 缺 playbook 报 `orphan_template`。

### `check-all`

- [ ] 实现 `data-harness-cli wikis check-all`。
- [ ] 按顺序执行：`check-index-md`、`check-titles`、`check-frontmatter`、`check-aliases`、`check-covers`、`check-links`。
- [ ] 默认即使某项失败，也继续执行后续可执行检查。
- [ ] 汇总所有检查错误。
- [ ] 支持 `--json`、`--max-errors`、`--fail-fast`。

## 阶段 3：`wikis build-index`

- [ ] 实现 `data-harness-cli wikis build-index`。
- [ ] 默认先执行 `check-all`。
- [ ] 只有全部检查通过后，才生成或更新 `.harness/index/wikis-index.json`。
- [ ] 支持 `--skip-checks`。
- [ ] 使用 `--skip-checks` 时向 stderr 输出明显 warning。
- [ ] 索引 meta 写入 `checksSkipped: true/false`。
- [ ] 即使使用 `--skip-checks`，遇到无法构建可靠索引的问题仍失败，例如 frontmatter 无法解析、文件无法读取、重复召回词。
- [ ] 使用临时文件写入索引，例如 `.harness/index/wikis-index.json.tmp.<pid>`。
- [ ] 完整生成成功后，用 rename 原子替换正式索引。
- [ ] 任一步失败时不更新旧索引，并清理临时文件。
- [ ] 写入前确保 `.harness/index` 目录存在。
- [ ] JSON 输出稳定格式化，文件末尾保留换行。
- [ ] 第一版不实现并发锁。

### `wikis-index.json` 内容

- [ ] 索引 meta 包含 schema `version`，第一版为 `1`。
- [ ] 索引 meta 包含生成时间。
- [ ] 索引 meta 包含根目录或知识库路径配置摘要。
- [ ] 索引 meta 包含 `checksSkipped`。
- [ ] 每个文档记录 `id`、逻辑路径、`kind`、`domain`、是否 `index.md`、一级标题。
- [ ] spec 文档记录 `name`、`label`、`aliases`、spec 类型。
- [ ] spec 类型区分普通指标 spec 与 `c-` 公共或概念 spec。
- [ ] playbook 文档记录是否普通 playbook、是否组合 playbook、对应 spec 路径、对应 template 路径、`aliases`、`covers`。
- [ ] template 文档记录对应 playbook 路径、是否 `index.md`、是否普通报告 template。
- [ ] 生成召回辅助信息。
- [ ] 检查结果不写入索引。

### 召回辅助信息

- [ ] 从普通 spec 的 `name`、`label`、`aliases` 生成召回项。
- [ ] 从已维护召回字段的 `c-` spec 生成召回项。
- [ ] 从组合 playbook 的 `aliases` 生成召回项。
- [ ] 普通 playbook 不生成召回项。
- [ ] `index.md` 和 template 不生成召回项。
- [ ] 每条召回项记录召回词、目标逻辑路径、来源字段。
- [ ] 使用严格字符串包含匹配作为第一版召回规则。
- [ ] 不实现分词、语义相似、拼音、模糊匹配、token 组合匹配。

## 阶段 4：Context 召回与 Session State

- [ ] 修改 context 使用 `.harness/index/wikis-index.json`。
- [ ] 基于召回辅助信息匹配用户问题。
- [ ] 用户问题包含召回词即命中。
- [ ] 命中普通 spec 后，通过同路径规则推导 playbook 和 template。
- [ ] 命中组合 playbook 后，通过同路径规则推导 template，并读取 `covers`。
- [ ] 多普通 spec 命中时，不拼接多个单指标 template。
- [ ] 多普通 spec 命中时，优先检查是否有组合 playbook alias 直接命中。
- [ ] 如果没有组合 alias 直接命中，遍历组合 playbook，查找 `covers` 完整覆盖全部命中 spec 的候选。
- [ ] 多个完整覆盖候选时，优先选择 `covers` 数量最少的组合 playbook。
- [ ] `covers` 数量仍并列时，优先选择 domain 最接近命中 spec 共同 domain 的组合 playbook。
- [ ] 仍并列时进入 `free`。
- [ ] 没有完整覆盖候选时进入 `free`。
- [ ] 不自动选择只覆盖部分命中 spec 的组合 playbook。

### Harness Mode

- [ ] 实现 `single` mode：命中一个普通 spec，并成功推导同路径 playbook 和 template。
- [ ] 实现 `combo` mode：命中组合 playbook，或多 spec 命中后找到唯一组合 playbook。
- [ ] 实现 `free` mode：没有唯一模板化链路，禁止 template 注入。
- [ ] context 阶段写入 session state。
- [ ] `single` 写入 `selectedPlaybook` 和 `selectedTemplate`。
- [ ] `combo` 写入 `selectedPlaybook`、`selectedTemplate`、`coveredSpecs`。
- [ ] `free` 写入 `reason`，并清空或不设置 `selectedPlaybook`、`selectedTemplate`。

### ContextFiles 展开

- [ ] `single`：加入 spec 路径上的所有 `index.md`。
- [ ] `single`：加入命中的普通 spec。
- [ ] `single`：加入 playbook 路径上的所有 `index.md`。
- [ ] `single`：加入 selected playbook。
- [ ] `single`：不加入 template。
- [ ] `combo`：加入 selected combo playbook 路径上的所有 `index.md`。
- [ ] `combo`：加入 selected combo playbook。
- [ ] `combo`：加入 `covers` 中每个 spec 路径上的所有 `index.md`。
- [ ] `combo`：加入 `covers` 中每个 spec。
- [ ] `combo`：不裁剪 `covers` spec，第一版全部加入。
- [ ] `combo`：不加入 template。
- [ ] `free` 完全没有命中时：只加入存在的 `spec/index.md`、`playbooks/index.md`。
- [ ] `free` 只命中 `c-` spec 时：加入该 `c-` spec 路径上的 spec `index.md` 和该 `c-` spec。
- [ ] `free` 多普通 spec 无组合覆盖时：加入每个命中 spec 的 spec index 链、spec、对应 playbook index 链、对应 playbook。
- [ ] `free` 多个组合候选并列时：加入候选组合 playbook index 链、候选组合 playbook、每个候选 covers spec 的 index 链和 spec。
- [ ] 所有 contextFiles 去重，保留第一次出现位置。

### ContextFiles 输出顺序

- [ ] `single` 顺序：spec index 链、spec、playbook index 链、selected playbook。
- [ ] `combo` 顺序：combo playbook index 链、combo playbook、按逻辑路径排序的 covers spec；每个 covers spec 前输出其 spec index 链。
- [ ] `free` 顺序：spec index 链、spec、playbook index 链、playbook。

### Context Instruction

- [ ] Context 输出明确包含 Harness mode。
- [ ] 模板化模式输出 `selectedPlaybook` 和 `selectedTemplate`。
- [ ] `combo` 模式输出 `coveredSpecs`.
- [ ] `free` 模式输出 `reason`。
- [ ] `single` instruction 要求先读全部 contextFiles。
- [ ] `single` instruction 要求完成 selected playbook 取数后执行 `bin/data-harness-cli inject-template`。
- [ ] `single` instruction 禁止 inject-template 前读取、打开、猜测或使用 `templates/`。
- [ ] `combo` instruction 要求先读全部 contextFiles。
- [ ] `combo` instruction 要求按组合 playbook 做多指标取数和分析。
- [ ] `combo` instruction 明确不要分别套用多个单指标 playbook/template。
- [ ] `combo` instruction 要求取数后执行 `bin/data-harness-cli inject-template`。
- [ ] `combo` instruction 禁止 inject-template 前读取、打开、猜测或使用 `templates/`。
- [ ] `free` instruction 要求先读全部 contextFiles。
- [ ] `free` instruction 明确不要执行 `bin/data-harness-cli inject-template`。
- [ ] `free` instruction 明确不要读取、打开、猜测或使用 `templates/`。
- [ ] `free` instruction 说明可参考 spec/playbook，但不能套用任何 template。
- [ ] 所有 mode 都输出通用约束：数值来自 CLI、不估算、不补造、不写报告文件除非用户要求、先读 contextFiles 再执行数据 CLI。

## 阶段 5：Inject Template

- [ ] 修改 `inject-template` 只读取 session state。
- [ ] `single` / `combo` 模式读取 `selectedTemplate`。
- [ ] `single` / `combo` 模式只注入 selected template 的 Markdown 正文。
- [ ] 成功注入时不额外注入 wrapper、mode、路径说明或其它解释。
- [ ] 如果 template 包含 frontmatter，注入时剥离 frontmatter。
- [ ] `free` 模式执行 `inject-template` 时不注入 template。
- [ ] `free` 模式返回明确提示：当前自由分析模式，不要执行 inject-template，继续自由分析且不要读取 templates。
- [ ] session state 缺失时不猜测 template，返回明确提示。
- [ ] 没有 `selectedPlaybook` 或 `selectedTemplate` 时不猜测 template，返回明确提示。
- [ ] `selectedTemplate` 文件不存在时视为 Wiki 完整性错误，返回明确错误，不降级读取其它 template。
- [ ] 重复执行 `inject-template` 时不重新选择 template；同一 session 同一 selected template 可重复注入同样正文。

## 迁移阶段：用工具审计并一次性修复 Wikis

- [ ] 在新 CLI、索引和检查命令完整前，不手工大规模迁移现有 Wikis。
- [ ] 工具完成后，运行 `data-harness-cli wikis check-all` 审计现有 Wikis。
- [ ] 汇总检查结果，分析错误分布。
- [ ] 制定一次性修复计划。
- [ ] 清理旧 frontmatter 字段。
- [ ] 补齐 `spec`、`playbooks`、`templates` 每层目录的 `index.md`。
- [ ] 调整普通 spec 的 `name`、`label`、`aliases`。
- [ ] 为组合 playbook 补齐 `aliases` 和 `covers`。
- [ ] 调整 spec/playbook/template 同路径同名对应关系。
- [ ] 迁移、废弃并删除 `wikis/routing`。
- [ ] 运行 `data-harness-cli wikis check-all` 确认修复完成。
- [ ] 运行 `data-harness-cli wikis build-index` 生成正式 `.harness/index/wikis-index.json`。
