# Wikis 命令规划

## 已确认决策

### 文档 ID

- Wiki 文档 ID 后续按文档路径自动生成。
- Wiki 作者不需要在 frontmatter 中手动维护 `id`。
- 手写 `id` 不再作为长期 Wiki 编写规范的一部分。
- 自动生成的 ID 必须是确定性的：同一个路径始终生成同一个 ID。
- `build-index` 和未来的 `wikis` 子命令，都应使用路径生成的 ID 作为文档在索引、查询和诊断中的身份标识。

### Routing

- 新规范中不再把 `routing` 作为必要的 Wiki 知识类型。
- Harness 核心链路调整为 `spec -> playbook -> template`。
- Context 召回可以基于路径推导、domain、aliases 和索引直接召回相关 spec 与 playbook，不再依赖 routing 作为中间层。
- 取数入口、命令、参数和执行步骤应由 playbook 承担。
- 历史 `wikis/routing` 目录后续可以逐步迁移、废弃并删除。
- 新的 `harness-cli wikis` 检查命令不应要求 routing 存在，也不再检查 routing 与 playbook/template 的一一对应关系。

### 文档 Kind

- `kind` 不再作为 Wiki 作者需要在 frontmatter 中手动维护的字段。
- Harness 仍然可以在内部保留 `kind` 概念，但它应由配置路径和文件名自动推导。
- 推导规则基于 `config/harness-config.yaml` 中的知识库路径配置，例如 `spec`、`playbooks`、`templates`。
- `index.md` 类型也应由文件名推导，例如 `spec/index.md` 或 `spec/**/index.md` 推导为 `spec_index`，普通 spec 文档推导为 `spec`。
- 历史文件中已有的手写 `kind` 后续可以逐步移除；校验逻辑不应再要求 frontmatter 必须包含 `kind`。

### 文档 Domain

- `domain` 不再作为 Wiki 作者需要在 frontmatter 中手动维护的字段。
- `domain` 不再使用 Go 代码中的固定白名单校验；新增业务域应通过目录结构表达，不需要修改代码白名单。
- `domain` 由文件路径自动推导，表示相对于知识类型根目录的业务归属路径。
- 多级目录天然表示多级 domain，例如 `wikis/spec/cmr/business/xxx.md` 的 domain 为 `cmr/business`，`wikis/playbooks/idx/price-manager/xxx.md` 的 domain 为 `idx/price-manager`。
- `spec`、`playbooks`、`templates` 应使用统一的 domain 目录结构，方便按同一业务归属检查链路完整性。
- 校验逻辑应检查同一 domain 下 `spec`、`playbooks`、`templates` 的结构一致性，而不是检查 domain 是否属于固定枚举。

### `index.md` 与 `children.path`

- `children.path` 不再作为 Wiki 作者需要人工维护的字段。
- 目录下有哪些子文档，应由 `build-index` 扫描文件系统自动生成，而不是由 `index.md` 手写清单维护。
- 如果 `index.md` 保留，它应只作为人工可读的 domain 说明文档，用于描述该业务域的范围、口径边界和使用注意事项。
- `index.md` 不再承担机器索引职责，也不再维护 `children.path`。
- 机器可读索引应由 `build-index` 生成 JSON 文件，例如 `.harness/index/spec-index.json`、`.harness/index/playbook-index.json`、`.harness/index/template-index.json`，未来也可以扩展为统一的 `.harness/index/wikis-index.json`。
- 后续校验逻辑不应要求 `index.md` 必须包含 `children.path`；如历史文件仍存在该字段，可逐步废弃或在迁移期忽略。

### 每层目录的 `index.md`

- `wikis/spec`、`wikis/playbooks`、`wikis/templates` 下的每一层业务目录都应维护 `index.md`。
- `index.md` 的目标是指导人和 AI Agent 渐进式阅读，而不是维护机器文件清单。
- 每层 `index.md` 应说明该目录代表的业务范围、口径边界、下级目录或文档的阅读路径、公共约束和不支持场景。
- AI Agent 可以先阅读上层 `index.md`，再逐步深入到具体 domain 或指标文档，避免一次性读取大量 Wiki 文件。
- `wikis/templates/**/index.md` 主要用于维护、审计和模板组织说明；运行时仍应遵守“inject-template 前禁止读取 templates”的约束。
- 未来 `harness-cli wikis` 下的检查命令必须包含该检查项：检查 `spec`、`playbooks`、`templates` 每层目录是否存在 `index.md`。
- 缺失 `index.md` 应直接作为 error 输出，不作为 warning。

### `context.default_files`

- 暂不保留 `context.default_files` 作为 Wiki frontmatter 规范。
- `index.md` 应专注表达业务知识、业务边界、阅读路径和口径说明，不应混入 Harness context 召回策略。
- Context 召回属于 Harness 工程化逻辑，应在 CLI、索引或独立配置中设计，不放进业务 Wiki 文档里。
- 现阶段尚未确认公共上下文自动召回的长期机制，因此先不把 `context.default_files` 纳入新的 Wiki 维护规范。
- 历史文件中已有的 `context.default_files` 后续可在迁移期兼容读取，但新的 `wikis` 检查命令不应要求该字段存在。

### Playbook 与 Template

- 有 playbook 就必须有对应 template。
- Playbook 到 template 的绑定不再通过 frontmatter 手写 `template` 字段维护。
- Template 路径由 playbook 路径按约定自动推导。
- 推导规则：playbook 与 template 使用相同的 domain 目录路径和相同文件名，只替换知识类型根目录。
- 例如 `wikis/playbooks/business/a.md` 对应 `wikis/templates/business/a.md`。
- 例如 `wikis/playbooks/idx/business-manager/s-sale-amt.md` 对应 `wikis/templates/idx/business-manager/s-sale-amt.md`。
- 未来 `harness-cli wikis` 下的检查命令必须检查每个 playbook 是否存在对应 template；缺失时应作为 error。
- 历史 playbook 中已有的手写 `template` 字段后续可以逐步移除；新规范不再要求该字段存在。

### Spec 与 Playbook

- 普通 spec 应有对应 playbook。
- Spec 到 playbook 的对应关系采用同 domain 路径、同文件名、仅替换知识类型根目录的规则。
- 例如 `wikis/spec/idx/business-manager/s-sale-amt.md` 对应 `wikis/playbooks/idx/business-manager/s-sale-amt.md`。
- 文件名以 `c-` 开头的 spec 是特例，不强制要求对应 playbook。
- 非 `c-` 前缀的普通 spec 必须有对应 playbook；缺失时应作为 error 输出。
- `index.md` 是目录说明文档，不参与 spec 与 playbook 的一一对应检查。
- 未来 `harness-cli wikis` 下的检查命令必须检查普通 spec 是否存在对应 playbook。

### Template 索引

- `template` 应作为 Harness Wiki 的一等对象参与索引。
- `build-index` 后续应扫描 `wikis/templates`，并生成 template 相关索引。
- Template 索引应使用与其他 Wiki 文档一致的路径推导规则生成 `id`、`kind` 和 `domain`。
- `kind` 可由 `wikis/templates` 路径推导为 `template`，`templates/**/index.md` 可推导为 `template_index`。
- 因为规范明确要求有 playbook 就必须有 template，所以 template 不能只在 inject-template 阶段临时读取；它需要进入索引和检查流程。
- 未来 `harness-cli wikis` 下的检查命令应基于 playbook 索引和 template 索引检查一一对应关系。

### Template 与 Playbook 的反向对应

- 普通报告 template 必须有对应 playbook。
- Template 与 playbook 采用同 domain 路径、同文件名、仅替换知识类型根目录的一一对应规则。
- 例如 `wikis/templates/idx/business-manager/s-sale-amt.md` 必须对应 `wikis/playbooks/idx/business-manager/s-sale-amt.md`。
- `templates/**/index.md` 是目录说明文档，不需要对应 playbook。
- 除 `index.md` 外，孤儿 template 应作为 error 输出。
- 公共模板片段或 `templates/common` 的长期规则暂不确认；第一版规范不把它作为普通报告 template 的例外。

### Title

- Markdown frontmatter 中不再需要维护 `title` 字段。
- 文档标题应直接从 Markdown 一级标题提取。
- 每个 Wiki Markdown 文件都必须有且只有一个明确的一级标题。
- 未来 `harness-cli wikis` 下的检查命令必须检查一级标题是否存在；缺失一级标题应作为 error。
- 历史文件中已有的 frontmatter `title` 后续可以逐步移除；新规范不再要求该字段存在。

### Name、Label 与 Aliases

- 关键词和别名不应长期维护为两个独立概念。
- 后续 Wiki 规范中只保留 `aliases`，用于召回和匹配。
- 不再保留独立的 `keywords` 概念。
- 历史文件中已有的 `match.keywords` 或其它关键词字段后续可以逐步迁移到 `aliases`。
- `aliases` 放在 Markdown frontmatter 中维护。
- 并不是每个文档都必须有 `aliases`。
- `index.md` 不需要维护 `aliases`。
- 普通单指标 spec 是单指标召回的主要入口，应维护 `name` 和 `label`。
- `name` 表示指标英文名、CLI 字段名、指标 code 或系统内部字段名。
- `label` 表示指标中文名或面向人的展示名。
- 普通单指标 spec 不强制维护 `aliases`；`aliases` 只用于补充用户可能使用的其它叫法。
- `name`、`label` 和 `aliases` 共同参与召回匹配。
- 普通单指标 playbook 不维护 `aliases`，避免与同路径 spec 重复。
- 组合 playbook 必须维护 `aliases`，用于召回业务问题级或多指标组合场景。
- 组合 playbook 必须同时维护 `covers`，用于声明覆盖的 spec。
- `aliases` 允许中文、英文、CLI 字段名、指标 code 混合维护。
- 普通单指标 spec 的 `name` 和 `label` 必须存在；缺失应作为 error 输出。
- `c-` 开头的公共或概念 spec 不强制要求 `name`、`label` 或 `aliases`。
- 单个文档内的 `aliases` 必须去重。
- `name`、`label`、`aliases` 必须做跨文档冲突检查；如果多个文档存在相同召回值，即使只冲突一个值，也应作为 error 输出。

### Frontmatter 字段收敛

- 新规范只允许保留已确认用途的 frontmatter 字段。
- 未知字段或废弃字段应直接作为 error 输出，不进入 warning 迁移期。
- 历史字段 `id`、`kind`、`domain`、`title`、`tags`、`match.keywords`、`context.default_files`、`children.path`、`template` 都应从 Wiki frontmatter 中清理。
- `harness-cli wikis` 下的检查命令必须检查 frontmatter 字段集合；发现未允许字段时应失败。

### Frontmatter 是否必需

- 不能再要求所有 Wiki Markdown 文件都必须有 frontmatter。
- 普通单指标 spec 必须有 frontmatter，因为需要维护 `name`、`label`，以及可选的 `aliases`。
- `c-` 开头的公共或概念 spec 可以没有 frontmatter；只有需要参与召回增强时才维护允许字段。
- `index.md` 可以没有 frontmatter。
- 普通单指标 playbook 可以没有 frontmatter，因为不维护 `aliases` 或 `covers`。
- 组合 playbook 必须有 frontmatter，因为需要维护 `aliases` 和 `covers`。
- Template 可以没有 frontmatter。
- `templates/**/index.md` 可以没有 frontmatter。
- `harness-cli wikis` 下的检查命令应按文档类型和路径判断 frontmatter 是否必需，而不是统一要求所有文件都有 frontmatter。

### Wiki 索引

- 后续使用统一的 Wiki 索引文件，不再以多个独立索引文件作为主要结构。
- 统一索引文件名使用 `.harness/index/wikis-index.json`。
- 索引中的路径使用逻辑路径，例如 `spec/idx/business-manager/s-sale-amt.md`，不使用物理路径 `wikis/spec/...`。
- 文档 ID 按逻辑路径生成，格式保留路径层级并去掉 `.md` 后缀，例如 `spec/idx/business-manager/s-sale-amt`。
- `wikis build-index` 默认必须先执行全部 Wiki 检查；只有全部检查通过后，才允许生成或更新索引。
- `wikis build-index` 可提供显式参数跳过检查，用于临时调试或迁移场景。
- 跳过检查必须是显式行为，不能作为默认行为。
- 即使跳过检查，`wikis build-index` 遇到无法解析或无法构建可靠索引的错误时仍应失败。
- 跳过检查的参数名使用 `--skip-checks`。
- 使用 `--skip-checks` 时，应向 stderr 输出明显 warning，提示当前索引绕过了 Wiki 规范检查。
- 使用 `--skip-checks` 生成的索引应在元信息中记录 `checksSkipped: true`。
- 未跳过检查并且检查通过生成的索引应记录 `checksSkipped: false`。
- 即使使用 `--skip-checks`，如果出现重复召回词、frontmatter 无法解析、文件无法读取等导致索引不可确定的问题，仍必须失败。
- `wikis build-index` 必须采用临时文件加原子替换的写入策略。
- 生成索引时不直接写 `.harness/index/wikis-index.json`，而是先写同目录临时文件，例如 `.harness/index/wikis-index.json.tmp.<pid>`。
- 完整扫描、检查、生成 JSON、写入临时文件都成功后，再用 rename 原子替换正式索引文件。
- 如果任一步失败，不更新现有 `.harness/index/wikis-index.json`，并清理临时文件。
- 写入前必须确保 `.harness/index` 目录存在。
- JSON 输出使用稳定格式化，便于 diff，并在文件末尾保留换行。
- 第一版暂不要求处理并发 `build-index` 的锁；如后续需要再引入 lock file。
- `wikis-index.json` 应包含索引元信息，例如 schema `version`、生成时间、根目录或知识库路径配置摘要。
- `version` 是索引结构版本号，由 CLI 代码常量控制；第一版为 `1`，不是时间戳或 git 版本。
- `wikis-index.json` 应包含每个 Markdown 文档的基础信息：`id`、逻辑路径、`kind`、`domain`、是否 `index.md`、从一级标题提取的标题。
- `wikis-index.json` 应包含 spec 相关字段：`name`、`label`、`aliases`、spec 类型。
- Spec 类型由文件名推导：`c-` 开头的 spec 记为公共或概念 spec，其它非 `index.md` spec 记为普通指标 spec。
- `wikis-index.json` 应包含 playbook 相关字段：是否普通单指标 playbook、是否组合 playbook、对应 spec 路径、对应 template 路径、`aliases`、`covers`。
- `wikis-index.json` 应包含 template 相关字段：对应 playbook 路径、是否 `index.md`、是否普通报告 template。
- `wikis-index.json` 应包含召回辅助信息，用于让 context 根据用户问题快速命中 spec 或组合 playbook。
- 检查结果不写入 `wikis-index.json`；检查结果由 `wikis check-*` 命令动态输出。

### 召回规则

- 第一版召回规则使用严格字符串包含匹配：用户问题包含召回词即命中。
- 第一版不做分词、语义相似、拼音、模糊匹配或 token 组合匹配。
- Wiki 作者需要在 `aliases` 中维护用户可能说出的常见完整表达。
- 普通指标 spec 使用 `name`、`label`、`aliases` 生成召回项。
- `c-` 开头的公共或概念 spec 不强制维护召回字段；如果维护了 `name`、`label` 或 `aliases`，也生成召回项。
- 组合 playbook 使用 `aliases` 生成召回项。
- 普通单指标 playbook 不生成召回项，因为它通过同路径 spec 间接命中。
- `index.md`、template、没有召回字段的 `c-` spec 不生成召回项。
- 每条召回项应记录召回词、目标逻辑路径和来源字段，例如 `name`、`label` 或 `aliases`。
- 所有召回词必须全局唯一；`name`、`label`、普通 spec `aliases`、`c-` spec 召回字段和组合 playbook `aliases` 之间如果出现重复，应作为 error。
- 单指标召回命中 spec 后，Harness 通过同路径规则推导对应 playbook 和 template。
- 组合问题召回命中组合 playbook 后，Harness 通过同路径规则推导对应 template，并通过 `covers` 理解其覆盖的 spec。

### 普通 Spec 命中后的 Context 展开

- 用户问题命中普通 spec 后，contextFiles 采用 spec 与 playbook 两边路径共同展开的规则。
- 需要加入 spec 文档所在目录最近一级 `index.md`，例如命中 `spec/idx/business-manager/s-sale-amt.md` 时只加入 `spec/idx/business-manager/index.md`。
- 需要加入命中的普通 spec 文档。
- 需要加入同路径 playbook 所在目录最近一级 `index.md`，例如只加入 `playbooks/idx/business-manager/index.md`。
- 需要加入同路径 playbook 文档，例如 `playbooks/idx/business-manager/s-sale-amt.md`。
- 不在 context 阶段加入 template；template 仍然只能在取数完成并执行 inject-template 后注入。

### 组合 Playbook 命中后的 Context 展开

- 用户问题命中组合 playbook 后，contextFiles 采用组合 playbook 与 `covers` spec 共同展开的规则。
- 需要加入组合 playbook 所在目录最近一级 `index.md`。
- 需要加入命中的组合 playbook 文档。
- 需要加入 `covers` 中每个 spec 所在目录最近一级 `index.md`。
- 需要加入 `covers` 中的每个 spec 文档。
- 第一版对 `covers` 中的 spec 全部加入，不做数量裁剪；如果 context 过大，后续应通过拆分组合 playbook 或优化组合范围解决。
- 不在 context 阶段加入 template；template 仍然只能在取数完成并执行 inject-template 后注入。

### 多 Spec 命中后的组合 Playbook 选择

- 用户问题同时命中多个普通 spec 时，不应简单拼接多个单指标 template。
- 如果用户问题直接命中某个组合 playbook 的 `aliases`，优先使用该组合 playbook。
- 如果没有直接命中组合 playbook，但命中了多个普通 spec，则遍历组合 playbook，查找 `covers` 能完整覆盖全部命中 spec 的候选组合 playbook。
- 组合 playbook 的 `covers` 必须完整覆盖用户问题命中的全部普通 spec，才可以被自动选择。
- 如果存在多个完整覆盖候选，优先选择 `covers` 数量最少的组合 playbook，避免选择过大的泛化组合模板。
- 如果 `covers` 数量仍然并列，优先选择 domain 最接近命中 spec 共同 domain 的组合 playbook。
- 如果仍然并列，不自动选择组合 playbook，进入自由分析模式。
- 如果没有任何组合 playbook 能完整覆盖全部命中 spec，进入自由分析模式。
- 不允许自动选择只覆盖部分命中 spec 的组合 playbook。

### 自由分析模式

- 在正常 Wiki 规范成立的前提下，自由分析模式只处理无法进入唯一模板化链路的场景。
- 完全没有命中 spec 或组合 playbook 时，进入自由分析模式。
- 只命中 `c-` 公共或概念 spec 时，进入自由分析模式。
- 命中多个普通 spec，但没有组合 playbook 的 `covers` 完整覆盖全部命中 spec 时，进入自由分析模式。
- 多个组合 playbook 候选同优先级并列，Harness 无法唯一选择时，进入自由分析模式。
- 完全没有命中时，contextFiles 只加入顶层入口 `spec/index.md`、`playbooks/index.md`，前提是文件存在。
- 只命中 `c-` spec 时，contextFiles 加入该 `c-` spec 所在目录最近一级 spec `index.md`，以及命中的 `c-` spec。
- 多普通 spec 命中但没有组合 playbook 完整覆盖时，contextFiles 加入每个命中 spec 所在目录最近一级 spec `index.md`、每个命中的 spec、每个对应 playbook 所在目录最近一级 playbook `index.md`、每个对应 playbook。
- 多个组合 playbook 候选并列时，contextFiles 加入所有候选组合 playbook 所在目录最近一级 `index.md`、所有候选组合 playbook、每个候选 `covers` 中 spec 所在目录最近一级 `index.md`、每个 `covers` spec。
- 自由分析模式永远不加入 `templates/**`。
- 自由分析模式永远不执行 `inject-template`。
- 自由分析模式可以读取 spec 和 playbook 作为口径、取数和分析参考，但最终输出必须是一份自由组织的报告，不套用单指标或组合 template。
- 如果运行时发现普通 spec 缺 playbook、playbook 缺 template、组合 playbook 缺 template、`covers` 引用不存在 spec 等异常，这属于 Wiki 质量错误，应由 `wikis check-*` 在维护阶段拦截；运行时可降级自由分析兜底，但不应视为正常流程。

### Harness Mode 与 Session State

- Context 阶段必须决定本轮 Harness mode，并写入 session state。
- Harness mode 使用三个取值：`single`、`combo`、`free`。
- `single` 表示命中一个普通 spec，并成功推导同路径 playbook 和 template。
- `combo` 表示命中组合 playbook，或多 spec 命中后找到唯一组合 playbook。
- `free` 表示没有唯一模板化链路，进入自由分析模式，禁止 template 注入。
- `single` 模式必须记录 `selectedPlaybook` 和 `selectedTemplate`。
- `combo` 模式必须记录 `selectedPlaybook`、`selectedTemplate` 和 `coveredSpecs`。
- `free` 模式必须记录进入自由分析的 `reason`，并清空或不设置 `selectedPlaybook`、`selectedTemplate`。
- `selectedTemplate` 必须由 `selectedPlaybook` 按路径规则推导，不再从 frontmatter `template` 字段读取。
- `contextFiles` 与 session state 必须一致；模板化模式下 contextFiles 应包含 `selectedPlaybook`，自由分析模式下不得包含 template。
- `inject-template` 只读取 session state 行动，不重新做召回、组合选择或 template 推断。
- 当 mode 为 `single` 或 `combo` 时，`inject-template` 读取并注入 `selectedTemplate`。
- 当 mode 为 `free` 时，`inject-template` 不注入 template，并返回明确提示：当前是自由分析模式，不要执行 `inject-template`。
- 当 session state 缺失或没有 `selectedTemplate` 时，`inject-template` 应返回错误提示，不允许猜测 template。

### ContextFiles 输出顺序

- `contextFiles` 必须使用稳定顺序输出，避免 AI Agent 阅读顺序不确定。
- `single` 模式输出顺序：
  - spec 路径上的 `index.md` 链，从上到下。
  - 命中的 spec。
  - playbook 路径上的 `index.md` 链，从上到下。
  - selected playbook。
- `combo` 模式输出顺序：
  - selected combo playbook 的 playbooks `index.md` 链，从上到下。
  - selected combo playbook。
  - `covers` spec 按逻辑路径排序。
  - 对每个 covers spec，先输出该 spec 路径上的 `index.md` 链，从上到下，再输出 spec 文档。
- `free` 模式输出顺序：
  - spec 路径上的 `index.md` 链。
  - spec 文档。
  - playbook 路径上的 `index.md` 链。
  - playbook 文档。
- 所有重复的 `index.md` 或文档路径都应去重，保留第一次出现的位置。

### Context Instruction

- Context 输出必须明确包含 Harness mode。
- 模板化模式下应输出 `selectedPlaybook` 和 `selectedTemplate`。
- `combo` 模式下还应输出 `coveredSpecs`。
- `free` 模式下应输出进入自由分析的 `reason`。
- `single` 模式 instruction 应明确：
  - `Harness mode: single`
  - 必须先读取全部 contextFiles。
  - 当前已选中单指标 playbook。
  - 完成 selected playbook 要求的全部取数步骤后，必须执行 `bin/data-harness-cli inject-template`。
  - inject-template 成功前，禁止读取、打开、猜测或使用 `templates/` 下任何文件。
  - inject-template 成功后，只能使用注入的 selected template 输出最终报告。
- `combo` 模式 instruction 应明确：
  - `Harness mode: combo`
  - 必须先读取全部 contextFiles。
  - 当前已选中组合 playbook。
  - 当前组合覆盖的 `coveredSpecs`。
  - 按组合 playbook 组织多指标取数和分析，不要分别套用多个单指标 playbook/template。
  - 完成 selected combo playbook 要求的全部取数步骤后，必须执行 `bin/data-harness-cli inject-template`。
  - inject-template 成功前，禁止读取、打开、猜测或使用 `templates/` 下任何文件。
  - inject-template 成功后，只能使用注入的 selected combo template 输出一份综合报告。
- `free` 模式 instruction 应明确：
  - `Harness mode: free`
  - 必须先读取全部 contextFiles。
  - 当前没有唯一可用的模板化链路，并说明原因。
  - 不要执行 `bin/data-harness-cli inject-template`。
  - 不要读取、打开、猜测或使用 `templates/` 下任何文件。
  - 可以参考 contextFiles 中的 spec/playbook 进行取数和分析，但不能套用任何 template。
  - 最终基于 CLI 证据自由组织一份分析报告。
  - 缺失口径或缺失数据必须明确说明，不得估算、补造或伪造。
- 所有模式都必须带通用约束：
  - 数值、同比、环比、排名、阈值必须来自 CLI 输出。
  - 不得估算、补造或用示例数值替代缺失数据。
  - 除非用户明确要求导出文件，否则不得写入报告文件。
  - 必须先读取 contextFiles，再执行数据 CLI。

### Inject Template 行为

- `inject-template` 只根据 session state 行动，不重新做召回、组合选择或 template 推断。
- 当 mode 为 `single` 或 `combo` 时，`inject-template` 读取 `selectedTemplate` 并注入模板正文。
- `single` 和 `combo` 成功注入时行为一致：只注入 selected template 的 Markdown 正文。
- 成功注入时不额外注入 mode、selectedPlaybook、selectedTemplate、路径说明或“以下是模板”等 wrapper。
- 如果 template 文件包含 frontmatter，注入时应剥离 frontmatter，只注入正文。
- 当 mode 为 `free` 时，`inject-template` 不注入 template，并返回明确提示：当前是自由分析模式，不要执行 `inject-template`，继续自由分析且不要读取 templates。
- 当 session state 缺失，或没有 `selectedPlaybook` / `selectedTemplate` 时，`inject-template` 不允许猜测模板，应返回明确提示：先根据 contextFiles 确定 mode，不要猜测或读取 templates。
- 当 `selectedTemplate` 文件不存在时，视为 Wiki 完整性错误；运行时应返回明确错误提示，不允许降级读取其它 template。
- 重复执行 `inject-template` 时，不重新选择 template；同一 session 同一 `selectedTemplate` 可以重复注入同样正文。

## 实施路线

### 阶段 1：Wiki 文档解析与路径推导

- 解析 Markdown 一级标题。
- 解析允许的 frontmatter 字段：`name`、`label`、`aliases`、`covers`。
- 按逻辑路径推导 `id`、`kind`、`domain`。
- 识别 `index.md`。
- 识别普通 spec、`c-` 公共或概念 spec。
- 识别普通 playbook、组合 playbook。
- 推导 spec、playbook、template 的对应路径。
- 补充单元测试覆盖路径推导和文档类型识别规则。

### 阶段 2：`wikis check-*`

- 实现 `check-index-md`。
- 实现 `check-titles`。
- 实现 `check-frontmatter`。
- 实现 `check-aliases`。
- 实现 `check-covers`。
- 实现 `check-links`。
- 实现 `check-all`。
- 该阶段先不改运行时 context，用于评估和治理现有 Wikis 距离新规范的差距。

### 阶段 3：`wikis build-index`

- 实现 `data-harness-cli wikis build-index`。
- 默认执行 `check-all`，全部通过后才生成索引。
- 支持 `--skip-checks`。
- 生成 `.harness/index/wikis-index.json`。
- 生成召回辅助信息。
- 在索引元信息中写入 `checksSkipped`。
- 使用临时文件加原子替换写入索引。
- 删除旧顶层 `build-index` 命令。

### 阶段 4：Context 召回与 Session State

- Context 使用新的 `wikis-index.json` 和召回辅助信息。
- 基于召回结果决策 Harness mode：`single`、`combo`、`free`。
- 按新规则展开 `contextFiles`。
- 输出新的 mode-specific instruction。
- 写入 session state：`mode`、`selectedPlaybook`、`selectedTemplate`、`coveredSpecs`、`reason`。

### 阶段 5：Inject Template

- `inject-template` 只读取 session state。
- `single` / `combo` 注入 `selectedTemplate` 正文。
- 注入时剥离 template frontmatter。
- `free` 模式拒绝注入，并提示继续自由分析。
- 缺失 session state 或 template 时不猜测、不降级读取其它 template。

## 迁移策略

- 先完整实现新的 CLI、索引和检查命令，确认所有 Wiki 规范都可以被工具化验证。
- 在工具能力完整前，不急于手工大规模迁移现有 Wikis。
- CLI 和检查命令完成后，先使用这些工具审计现有 Wikis，明确实际缺口和错误分布。
- 根据检查结果再制定一次性修复计划，集中清理旧 frontmatter、补齐 `index.md`、调整 spec/playbook/template 对应关系、迁移或删除 routing。
- 迁移修复应以工具检查结果为依据，避免在规范和工具尚未稳定时进行反复人工修补。

### `wikis` 子命令

- 后续索引生成命令使用 `data-harness-cli wikis build-index`。
- 不再需要顶层 `data-harness-cli build-index` 作为长期命令。
- 旧的顶层命令命名不保留兼容 alias，可以完全删除。
- `data-harness-cli wikis build-index` 默认先执行全部检查，通过后才生成 `.harness/index/wikis-index.json`。
- `data-harness-cli wikis build-index` 支持显式跳过检查的参数，例如 `--skip-checks`。
- Wiki 检查命令按检查项拆分，每个检查细节都有对应子命令。
- 第一版检查命令包括：
  - `data-harness-cli wikis check-index-md`
  - `data-harness-cli wikis check-frontmatter`
  - `data-harness-cli wikis check-aliases`
  - `data-harness-cli wikis check-covers`
  - `data-harness-cli wikis check-links`
  - `data-harness-cli wikis check-titles`
  - `data-harness-cli wikis check-all`
- `check-index-md` 检查 `spec`、`playbooks`、`templates` 每层目录是否有 `index.md`。
- `check-frontmatter` 检查 frontmatter 是否只包含允许字段，并检查必须有 frontmatter 的文件是否实际缺失。
- `check-titles` 检查每个 Markdown 是否有且只有一个一级标题。
- `check-aliases` 检查普通 spec 的 `name` / `label`，检查 `aliases` 去重，检查 `name` / `label` / `aliases` 跨文档冲突，检查普通 playbook 不维护 `aliases`，检查组合 playbook 必须维护 `aliases`。
- `check-covers` 检查组合 playbook 是否有 `covers`，检查 `covers` 只引用 spec 逻辑路径，检查 `covers` 引用的 spec 是否存在。
- `check-links` 检查 `spec -> playbook`、`playbook -> template`、`template -> playbook` 的对应关系，并处理 `c-` spec 和 `index.md` 例外。
- `check-all` 按顺序执行全部检查项。
- `check-all` 执行顺序为：`check-index-md`、`check-titles`、`check-frontmatter`、`check-aliases`、`check-covers`、`check-links`。
- `check-all` 即使某个检查项失败，也应继续执行后续可执行检查，最后汇总所有错误。
- 只要存在任意 error，`check-all` 最终 exit code 应为 `1`。
- 所有 `wikis check-*` 命令使用统一错误模型。
- 每条 error 至少包含 `check`、`path`、`code`、`message`。
- 可选字段包括 `target`、`value`、`other`，用于表达引用目标、冲突值或相关冲突文档。
- `path` 和 `target` 都使用逻辑路径。
- 检查命令应支持普通文本输出和 `--json` 输出。
- 单个检查命令和 `check-all` 的 JSON 输出结构应保持一致；单个检查命令只包含一个 check 结果。
- exit code 规则：`0` 表示没有 error，`1` 表示存在 error，`2` 表示命令参数错误或运行时异常。
- 默认返回尽可能多的错误，但必须设置输出上限，避免海量错误淹没终端。
- 默认每个单项 check 最多展示 `100` 条 error。
- 默认 `check-all` 总计最多展示 `500` 条 error。
- 超过上限时，文本和 JSON 输出都必须标记 `truncated=true`，并展示总错误数、已展示错误数和隐藏错误数。
- 检查命令应支持 `--max-errors N`，用于调整最多展示的错误数量。
- 检查命令应支持 `--fail-fast`，用于遇到第一条 error 后立即停止；`check-all --fail-fast` 按既定顺序执行，在发现第一条 error 后停止并返回 exit code `1`。
- 错误码 `code` 使用全局唯一的 snake_case，不带 check 前缀。
- 每条 error 已有 `check` 字段，因此 `code` 只表达错误本身，不重复检查命令名称。
- 错误码一旦发布不应随意改名；后续可以新增 code，但旧 code 应保持兼容。
- `message` 可以优化调整，但 `code` 应保持稳定。
- 第一批错误码包括：
  - `missing_index_md`
  - `missing_h1`
  - `multiple_h1`
  - `missing_frontmatter`
  - `unknown_frontmatter_field`
  - `missing_required_field`
  - `invalid_frontmatter_type`
  - `missing_name`
  - `missing_label`
  - `duplicate_alias`
  - `duplicate_recall_value`
  - `alias_not_allowed`
  - `missing_covers`
  - `invalid_cover_path`
  - `missing_cover_target`
  - `invalid_covers_type`
  - `missing_playbook`
  - `missing_template`
  - `orphan_template`

### Tags

- `tags` 不再作为新的 Wiki frontmatter 规范。
- Harness 不应依赖 `tags` 判断文档类型、是否需要 template、是否参与报告生成。
- 历史文件中已有的 `tags` 后续可以逐步移除或在迁移期兼容忽略。
- 过去由 `tags` 表达的职责，应优先通过目录结构、路径推导、playbook-template 一一对应规则或后续明确的新机制表达。

### Playbook 文档职责

- `wikis/playbooks/**` 下的每个非 `index.md` Markdown 文件，都应视为一个可运行分析流程文档。
- 可运行分析流程文档应能指导 AI Agent 完成一次具体分析工作流，包括取数入口、命令、参数、步骤、成功标准和必要证据。
- `wikis/playbooks/**` 下的非 `index.md` 文件必须有同路径同名 template。
- 纯说明性文档不应放在 `wikis/playbooks/**` 的普通 Markdown 文件中；如需说明业务范围或阅读路径，应放在对应目录的 `index.md`。
- Playbook 命令指 fenced code block 中声明的 shell 命令。
- 第一阶段暂不检查 playbook 命令是否真实可执行。
- 组合 playbook 通过是否存在同路径同名 spec 来识别。
- 如果 playbook 存在同路径同名 spec，则视为普通单指标 playbook。
- 如果 playbook 不存在同路径同名 spec，则视为组合 playbook，必须维护 `covers`。

### 单指标、多指标与综合问题的模板选择

- 单指标问题如果能找到完整 `spec -> playbook -> template` 链路，则走标准模板化流程：读取 spec 和 playbook，完成取数后注入对应 template 生成报告。
- 单指标问题如果找不到完整链路，则进入自由分析模式，不执行 template 注入；如果只有 spec，可以用 spec 理解口径，但不能假设不存在的 playbook/template。
- 多指标问题不要简单拼接多个单指标 template，最终应输出一份综合报告。
- 多指标问题应优先查找组合 playbook/template；只要某个组合 playbook 明确覆盖用户问题中需要的指标集合，就可以认为命中组合 playbook。
- 普通单指标 playbook 不需要 `covers`，因为它和 spec 使用同路径同名规则一一对应。
- 组合 playbook 必须在 frontmatter 中维护 `covers`，显式声明它覆盖哪些 spec。
- `covers` 只引用 spec 逻辑路径，不引用 playbook 或 template。
- `covers` 中引用的 spec 必须存在。
- `covers` 可以引用 `c-` 开头的公共或概念 spec。
- 未来 `harness-cli wikis` 下的检查命令必须检查组合 playbook 是否维护 `covers`，以及 `covers` 引用的 spec 是否存在。
- 如果存在专门组合 playbook/template，则使用该组合链路生成综合报告。
- 如果没有专门组合 playbook/template，但用户问题中的指标都属于同一个 domain，且该 domain 存在通用多指标 playbook/template，则使用 domain 级通用多指标链路。
- 如果用户问题跨多个 domain，应优先查找这些 domain 的共同上级 domain 下是否存在组合 playbook/template；例如 `idx/business-manager` 与 `idx/price-manager` 的共同上级为 `idx`。
- 跨 domain 场景只有在共同上级 domain 存在明确覆盖该问题的组合 playbook/template 时，才进入模板化流程。
- 多指标问题如果全部不能命中 spec/playbook，进入自由分析模式，不执行 template 注入。
- 多指标问题如果只有部分指标命中 spec/playbook，默认进入自由分析模式；只有当组合 playbook 明确允许并覆盖“部分指标缺失”的场景时，才使用组合模板。
- 综合性业务问题应优先查找业务问题级 playbook/template，例如经营诊断、品效下钻、会员表现诊断等。
- 综合性业务问题如果没有业务问题级链路，但能命中同 domain 的通用多指标 playbook/template，可以使用通用多指标链路。
- 综合性业务问题如果跨 domain，则按共同上级 domain 的组合 playbook/template 判断；没有明确组合链路时进入自由分析模式。
- 自由分析模式仍必须遵守 Harness 运行约束：数值来自 CLI，不估算缺失数据，不读取 templates，不伪造缺失口径。
