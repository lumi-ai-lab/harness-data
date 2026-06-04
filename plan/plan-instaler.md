# Installer 方案重整

## 背景

当前 npm installer 的实现会 clone `lumi-ai-lab/harness-data` 到用户本机，并把这个 checkout 作为 Harness Data workspace 使用。

这个方式可以工作，但用户真实使用时并不需要关注 `harness-data` 源码仓库本身。用户真正需要的是：

- `data-harness-cli` 运行入口。
- `wikis` 知识库。
- 原始本地配置，例如 `config/harness-config.yaml`、`config/qdm-cli-paths.env`。
- `.agents` 中不同 Agent 的 hook 模板。
- QDM 依赖 CLI，例如 `qdm-cmr-cli`、`qdm-indicators-cli`、`cas-cli`。

因此 installer 的长期目标不应是“clone 一个源码项目给用户”，而应是“安装一个 Harness Data runtime”。

## 核心决策

用户不再 clone `harness-data` 源码仓库。

`harness-data` 仓库只作为维护者开发仓库存在，用于：

- 开发和测试 `data-harness-cli`。
- 维护 npm installer。
- 维护 agent hook 模板。
- 维护 bootstrap manifest。
- 编排 release。

用户侧只安装 runtime 目录。runtime 目录只包含实际运行所需文件，不包含 `cli/`、`npm/`、`tests/`、`plan/`、`.github/` 等开发内容。

## 用户侧运行目录

默认安装目录使用执行 `npx ... install` 时所在的当前目录。

用户也可以通过 `--dir` 显式指定安装目录：

```bash
npx @lumi-ai-lab/harness-data install --dir /path/to/runtime
```

安装目录统一记为：

```text
<runtime-dir>/
```

目录结构：

```text
<runtime-dir>/
  bin/
    data-harness-cli
    qdm-cmr-cli
    qdm-indicators-cli
    cas-cli
  wikis/
    spec/
    playbooks/
    templates/
  config/
    harness-config.yaml
    qdm-cli-paths.env
  agents/
    claude/
    codex/
    pi/
  .harness/
    index/
    state/
```

说明：

- `bin/` 存放所有运行时 CLI。
- `wikis/` 是业务知识库，可以来自 git clone、release asset 或压缩包。
- `config/` 是本机配置，不提交到源码仓库。
- `agents/` 是 Agent hook 模板，不再要求用户看到 `.agents` 源码目录。
- `.harness/index/` 存放 `wikis build-index` 生成的索引。
- `.harness/state/` 存放 hook 运行态和 session 状态。

## 运行目录来源

因为用户不再 clone `harness-data` 源码仓库，所以 `<runtime-dir>` 里的内容必须由 installer 组装出来。

推荐来源拆分：

| 目录或文件 | 来源 | 说明 |
| --- | --- | --- |
| `bin/data-harness-cli` | `harness-data` GitHub Release asset | installer 按当前平台下载。 |
| `bin/cas-cli` | `qdm-cas-cli` GitHub Release asset 或用户本地路径 | GitHub Token 自动模式下载；本地路径模式复制或引用用户指定文件。 |
| `bin/qdm-indicators-cli` | `qdm-indicators-cli` GitHub Release asset 或用户本地路径 | 同上。 |
| `bin/qdm-cmr-cli` | `qdm-cmr-cli` GitHub Release asset 或用户本地路径 | 同上。 |
| `wikis/` | `harness-data-wikis` 仓库或 release asset | GitHub Token 自动模式下载；本地路径模式使用用户指定目录。 |
| `config/harness-config.yaml` | installer 根据 runtime 路径生成 | 不直接使用源码仓库里的真实配置。 |
| `config/qdm-cli-paths.env` | installer 根据 runtime 路径生成 | 写入当前安装后的 CLI 路径。 |
| `agents/` | runtime bundle | 从 `harness-data` release 的 runtime bundle 展开。 |
| `bootstrap/cli-manifest.json` | runtime bundle | 工具发现与下载规则清单，不作为中心版本锁。 |
| `.harness/index/` | `data-harness-cli wikis build-index --skip-checks` 生成 | 不是 release 产物。 |
| `.harness/state/` | installer 和 hook 运行时生成 | 不是 release 产物。 |
| `.qdm-auth/` | installer 根据 CAS username/password 生成 | 不是 release 产物，不进入 git。 |
| `.claude` / `.codex` / `.pi` | installer 创建软链 | 指向 `<runtime-dir>/agents/*`。 |

因此 runtime 目录不是一个直接从源码仓库 clone 出来的目录，而是 installer 通过 release asset、wikis 资源、本地配置和运行态文件组装出来的目录。

## 平台识别

installer 应支持当前 `data-harness-cli` release 覆盖的 4 个平台。

第一版按 Node.js 平台信息自动识别：

```text
process.platform
process.arch
```

平台映射：

```text
darwin + arm64 -> darwin-arm64
darwin + x64   -> darwin-amd64
linux  + x64   -> linux-amd64
win32  + x64   -> windows-amd64
```

说明：

- installer 应根据识别出的平台选择对应 release asset。
- Windows 下二进制文件名应自动使用 `.exe` 后缀，例如 `data-harness-cli.exe`。
- 压缩包格式应按平台处理，例如 Windows 使用 `.zip`，macOS/Linux 使用 `.tar.gz`。
- 如果当前系统不在支持列表中，应在安装开始阶段直接失败，并提示当前检测到的 `process.platform` 和 `process.arch`。

默认安装目录不按平台分散到不同系统目录，统一使用执行命令所在目录。这样用户可以清楚看到 runtime 内容，也方便本地路径模式自动识别。

## 安装器职责

installer 应完成以下步骤：

1. 创建或复用 runtime 目录。
2. 下载 `data-harness-cli` release binary。
3. 下载 `qdm-cmr-cli`、`qdm-indicators-cli`、`cas-cli`。
4. 下载或更新 `wikis` 知识库。
5. 写入本地 config。
6. 收集 CAS username/password 并写入本地 CAS credentials，不在这一步单独校验。
7. 使用 CAS ticket/token 为 CMR 和 Indicators CLI 配置 token，并通过 CMR/Indicators CLI 校验 token。
8. 执行 `data-harness-cli wikis build-index --skip-checks`。
9. 根据用户选择安装 Agent hook。
10. 执行 doctor 校验 runtime 是否可用。

installer 不再执行：

```bash
git clone https://github.com/lumi-ai-lab/harness-data
```

## 安装模式

installer 应支持两种安装模式，让用户按自己的环境选择。

### GitHub Token 自动模式

如果用户配置了 GitHub token，installer 应全自动完成私有资源下载和后续更新检查。

可用 token 来源：

- `--github-token TOKEN` 直接指定 token。
- 默认环境变量 `GITHUB_TOKEN`。
- 本机 `gh auth login` 的登录状态。

自动下载内容：

- `data-harness-cli`。
- `cas-cli`。
- `qdm-indicators-cli`。
- `qdm-cmr-cli`。
- `harness-data-wikis`。

自动模式下，用户不需要手动下载 CLI，也不需要手动 clone 或更新 `harness-data-wikis`。

安装命令示例：

```bash
GITHUB_TOKEN=... npx @lumi-ai-lab/harness-data install
```

或：

```bash
npx @lumi-ai-lab/harness-data install \
  --github-token ...
```

更新时，installer 应检查：

- runtime bundle 是否有新版本。
- `data-harness-cli` 是否有新版本。
- `cas-cli`、`qdm-indicators-cli`、`qdm-cmr-cli` 是否有新版本。
- `harness-data-wikis` 是否有新 commit 或新 release。

如果发现更新，应先展示更新摘要，再让用户确认是否更新。用户确认后再下载和替换。

### 本地路径模式

如果用户没有配置 GitHub token，installer 不应强制失败，而应进入本地路径模式。

本地路径模式下，用户需要提供：

- `cas-cli` 路径。
- `qdm-indicators-cli` 路径。
- `qdm-cmr-cli` 路径。
- `harness-data-wikis` 路径。

installer 应先做快捷自动识别。

如果执行 `npx ... install` 的当前目录下存在 `bin/`，并且可以找到以下文件，则自动识别：

```text
./bin/cas-cli
./bin/qdm-indicators-cli
./bin/qdm-cmr-cli
```

Windows 下自动识别对应 `.exe` 文件：

```text
.\bin\cas-cli.exe
.\bin\qdm-indicators-cli.exe
.\bin\qdm-cmr-cli.exe
```

缺少哪个 CLI，就只提示用户补充哪个 CLI 的路径。

如果执行 `npx ... install` 的当前目录下存在：

```text
./harness-data-wikis
```

则自动识别为 wikis 路径。

如果不存在，则提示用户指定 `harness-data-wikis` 路径。

本地路径模式不增加 `install` 命令参数来传这些路径。缺少自动识别项时，installer 逐项交互式询问用户输入绝对路径。

交互提示示例：

```text
Path to cas-cli:
Path to qdm-indicators-cli:
Path to qdm-cmr-cli:
Path to harness-data-wikis:
```

用户输入后，installer 应校验：

- CLI 路径存在且可执行。
- `harness-data-wikis` 路径存在，且包含 `spec/`、`playbooks/`、`templates/`。

CAS username/password 不属于本地路径模式的 CLI 路径参数，仍由 CAS 认证步骤交互式输入。

本地路径模式下，`update` 不能直接替用户下载私有 GitHub 资源，但仍应：

- 检查当前 runtime 中记录的版本。
- 检查用户提供的本地 CLI 路径是否仍然存在且可执行。
- 如果 `harness-data-wikis` 是 git 仓库，可以检查是否落后于 remote。
- 提醒用户哪些组件需要手动更新。

## CAS 认证

CAS 认证统一只保留交互式输入，这是最安全的方式。

installer 提示用户输入：

- CAS username。
- CAS password。

然后 installer 自动在当前安装目录下生成认证文件。

当前安装目录的含义：

- 如果用户指定了 `--dir`，则使用 `--dir` 指定目录。
- 如果用户未指定 `--dir`，则使用执行 `npx ... install` 的当前目录。

认证文件统一放在当前安装目录的 `.qdm-auth` 下：

```text
<runtime-dir>/.qdm-auth/
```

建议结构：

```text
<runtime-dir>/.qdm-auth/
  cas/
    config.json
```

`config.json` 由 installer 生成，不要求用户手写。

installer 只负责收集 username/password 并生成 CAS credentials 文件，不在这一阶段单独调用 CAS credentials 校验。实际可用性验证下放到后续 CMR/Indicators token 配置步骤。

安全要求：

- 不支持通过命令行参数传入 CAS password，避免 shell history、进程列表或日志泄露。
- `.qdm-auth` 目录权限应尽量收敛，例如 `0700`。
- `config.json` 不应写入 git 仓库。
- `doctor` 不输出 password。
- `update` 不覆盖已有 CAS credentials，除非用户显式要求重新配置。

CAS credentials 生成后，installer 应继续自动通过 `cas-cli` 获取 ticket/token，并写入 CMR/Indicators CLI 配置：

```bash
cas-cli token --app cmr
cas-cli token --app indicators
```

并把 token 写入：

- `qdm-cmr-cli` 配置。
- `qdm-indicators-cli` 配置。

随后通过 CMR/Indicators CLI 自身的 token 校验命令确认认证链路可用。这样不需要在 CAS credentials 生成阶段做重复校验。

## Runtime Bundle

推荐方案是在 `harness-data` 仓库新增 GitHub Action release 步骤，打包一个小型 runtime bundle，并上传到同一个 GitHub Release。

`harness-data` release 应提供 runtime bundle，例如：

```text
harness-data-runtime-v0.0.5.tar.gz
```

其中 `v0.0.5` 必须和 `harness-data` GitHub Release tag 完全一致。也就是说，`v0.0.5` release 下的 runtime bundle 文件名就是：

```text
harness-data-runtime-v0.0.5.tar.gz
harness-data-runtime-v0.0.5.tar.gz.sha256
```

runtime bundle 不需要按操作系统拆分。它只包含 agent 模板、config example 和 manifest，不包含平台相关二进制。平台差异由 installer 在下载 `data-harness-cli` 和 QDM CLI release asset 时处理。

bundle 内容：

```text
agents/
  claude/
  codex/
  pi/
config/
  harness-config.yaml.example
  qdm-cli-paths.env.example
bootstrap/
  cli-manifest.json
```

runtime bundle 不包含：

- `cli/` 源码。
- `npm/` 源码。
- `tests/`。
- `plan/`。
- `.github/`。
- 本机真实 `config/harness-config.yaml`。
- 本机真实 `config/qdm-cli-paths.env`。
- `.qdm-auth/`。
- `.harness/state/`。

第一阶段不建议把 `wikis`、`data-harness-cli` 和三个 QDM CLI 都塞进 runtime bundle。

原因：

- `data-harness-cli` 已经有 4 平台 release asset，继续按平台独立下载更清晰。
- `cas-cli`、`qdm-indicators-cli`、`qdm-cmr-cli` 属于独立私有仓库，独立检查 release/tag/checksum 更适合更新。
- `wikis` 更新频率可能高于 runtime 模板，独立更新可以避免每次 wikis 变化都重新发布 runtime bundle。
- runtime bundle 保持小体积，只承担模板和 manifest 分发职责。

推荐第一阶段采用：

- runtime bundle 包含 agent 模板、config 模板和 manifest。
- `data-harness-cli`、QDM CLI 按 manifest 中的 repo、binary、平台和 asset 规则定位下载资源。
- `wikis` 仍从 `harness-data-wikis` 获取。

这样 release 结构清晰，同时版本和 checksum 判断仍由 installer 实时访问各远程仓库完成。

GitHub Action 打包逻辑建议放进 `release.yml` 总编排中，在 release tag 创建后执行：

```bash
mkdir -p dist/runtime/agents dist/runtime/config dist/runtime/bootstrap
cp -R .agents/claude dist/runtime/agents/claude
cp -R .agents/codex dist/runtime/agents/codex
cp -R .agents/pi dist/runtime/agents/pi
cp config/harness-config.yaml.example dist/runtime/config/harness-config.yaml.example
cp config/qdm-cli-paths.env.example dist/runtime/config/qdm-cli-paths.env.example
cp bootstrap/cli-manifest.json dist/runtime/bootstrap/cli-manifest.json
tar -C dist/runtime -czf "dist/harness-data-runtime-${VERSION_TAG}.tar.gz" .
shasum -a 256 "dist/harness-data-runtime-${VERSION_TAG}.tar.gz" > "dist/harness-data-runtime-${VERSION_TAG}.tar.gz.sha256"
```

然后把以下文件上传到 GitHub Release：

```text
harness-data-runtime-vX.Y.Z.tar.gz
harness-data-runtime-vX.Y.Z.tar.gz.sha256
```

installer 安装时：

1. 查询 `harness-data` 最新 release。
2. 下载 `harness-data-runtime-<tag>.tar.gz` 和 `.sha256`。
3. 校验 sha256。
4. 展开到临时目录。
5. 把 `agents/`、`config/*.example`、`bootstrap/cli-manifest.json` 安装到 `<runtime-dir>`。
6. 基于 example 和当前 runtime 路径生成真实 `config/harness-config.yaml`、`config/qdm-cli-paths.env`。

安装器必须把 bundle 中的 example 配置转成真实可用配置：

- `config/harness-config.yaml.example` 作为模板输入。
- `config/qdm-cli-paths.env.example` 作为模板输入。
- 生成 `config/harness-config.yaml`。
- 生成 `config/qdm-cli-paths.env`。

生成后的真实配置应指向 `<runtime-dir>` 下的实际路径，例如：

```yaml
paths:
  spec: wikis/spec
  playbooks: wikis/playbooks
  templates: wikis/templates

cli:
  qdm_cmr_cli: <runtime-dir>/bin/qdm-cmr-cli
  qdm_indicators_cli: <runtime-dir>/bin/qdm-indicators-cli
  qdm_cas_cli: <runtime-dir>/bin/cas-cli
```

Windows 下应写入 `.exe` 路径，例如 `<runtime-dir>/bin/qdm-cmr-cli.exe`。

## CLI Manifest 定位

保留 `bootstrap/cli-manifest.json`，但调整定位。

它不再作为中心版本锁，也不再决定 installer 必须安装哪个固定版本。版本判断以 installer 运行时访问 GitHub release/tag/checksum 的结果为准。

`cli-manifest.json` 的长期定位是工具发现与下载规则清单，也可以理解为 bootstrap seed。

建议保留字段：

- tool name，例如 `cas-cli`。
- binary name，例如 `cas-cli` 或 Windows 下的 `cas-cli.exe`。
- GitHub repo，例如 `pengmide/qdm-cas-cli`。
- 是否 private。
- 支持平台列表。
- asset 命名规则，例如 `{binary}-{tag}-{platform}.{archive}`。
- checksum 命名规则，例如 `{asset}.sha256`。

建议弱化或移除的字段：

- 固定 version。
- 每个平台写死的完整 URL。
- 作为唯一更新依据的 sha256。

如果短期仍保留 `version`、`url`、`sha256` 字段，应只把它们作为 fallback：

- GitHub latest release/tag 探测失败时，可以按 manifest 尝试下载。
- 首次安装时，如果远程探测不可用，可以给出 manifest 中的默认候选。
- update 时不以 manifest version 判断是否最新，仍以远程 repo 当前 latest release/tag/checksum 为准。

这样保留 manifest 的好处是：

- repo、binary、平台和 asset 规则不用硬编码死在 installer 代码里。
- 后续改 asset 命名或新增平台时，可以通过 runtime bundle 更新清单。
- 用户仍不需要理解或编辑 manifest。

## Wikis 获取方式

`wikis` 是用户真实需要的业务知识库，可以继续使用独立仓库：

```text
harness-data-wikis
```

第一阶段允许 installer 使用 git clone 或 git pull 更新 `wikis`：

```text
<runtime-dir>/wikis
```

但 clone 的应该是 `harness-data-wikis`，不是 `harness-data`。

长期可以支持两种模式：

- git 模式：适合需要频繁更新知识库的团队。
- release asset 模式：适合只需要稳定版本知识库的用户或 CI。

## Agent Hook 安装

installer 应在安装过程中交互式询问用户启用哪些 Agent。

支持选项：

```text
claude
codex
pi
all
```

默认选择 `all`。

用户选择后，installer 把 `<runtime-dir>/agents` 下对应的 Agent 配置软链到 `<runtime-dir>` 根目录。

映射规则：

```text
<runtime-dir>/agents/pi     -> <runtime-dir>/.pi
<runtime-dir>/agents/claude -> <runtime-dir>/.claude
<runtime-dir>/agents/codex  -> <runtime-dir>/.codex
```

如果用户选择 `all`，则同时创建三组软链。

如果目标路径已经存在，installer 应提示用户选择：

- 覆盖现有配置。
- 跳过当前 Agent。

非交互场景下，如果目标路径已存在，应默认失败，避免覆盖用户已有 Agent 配置。

hook 内部命令仍可以使用 runtime 相对路径，例如：

```bash
"$(git rev-parse --show-toplevel)/bin/data-harness-cli" context --format codex-hook
```

因为 Agent 配置软链到 `<runtime-dir>` 后，用户在 `<runtime-dir>` 中启动 Agent 时，项目根目录就是 runtime 目录。

## 命令入口命名

当前 npm 包名是：

```text
@lumi-ai-lab/harness-data
```

长期更清晰的命名是：

```text
@lumi-ai-lab/harness-data-cli
```

可选迁移策略：

1. 保留 `@lumi-ai-lab/harness-data` 兼容现有安装命令。
2. 新增 `@lumi-ai-lab/harness-data-cli` 作为推荐入口。
3. 文档统一把用户安装对象称为 Harness Data CLI runtime。

推荐用户命令：

```bash
npx @lumi-ai-lab/harness-data-cli install
npx @lumi-ai-lab/harness-data-cli update
npx @lumi-ai-lab/harness-data-cli doctor
```

兼容命令：

```bash
npx @lumi-ai-lab/harness-data install
```

## Update 语义

`update` 不再表示更新 `harness-data` 源码 checkout。

更新只通过一个命令触发：

```bash
npx @lumi-ai-lab/harness-data update
```

不需要 `--check`、`--yes` 或其它复杂参数。整个更新过程保持交互式。

installer 按固定顺序逐项检查：

- installer npm 包版本。
- runtime bundle 版本。
- `data-harness-cli` 版本。
- `cas-cli` 版本。
- `qdm-indicators-cli` 版本。
- `qdm-cmr-cli` 版本。
- `wikis` 版本、tag 或 git commit。
- agent hook 模板版本。

检查 CLI 更新时，installer 使用 `bootstrap/cli-manifest.json` 找到对应 repo、binary、平台和 asset 命名规则，但最新版本和 checksum 以远程 GitHub release/tag 查询结果为准。

每一项的处理规则：

1. 检查当前项是否有更新。
2. 如果没有更新，直接进入下一项。
3. 如果发现更新，立即阻塞并展示当前项的更新信息。
4. 用户选择 `yes` 或 `skip`。
5. 如果用户选择 `yes`，installer 先完成当前项更新。
6. 当前项更新成功后，再继续检查下一项。
7. 如果用户选择 `skip`，当前项不更新，继续检查下一项。
8. 所有项检查完成后，输出本次更新摘要。

发现更新时的提示示例：

```text
cas-cli has update:
  current: v0.0.1 sha256=aaa
  remote:  v0.0.2 sha256=bbb

Update cas-cli? [yes/skip]
```

如果 tag 没变但 checksum 不同，也认为需要更新：

```text
qdm-cmr-cli has update:
  current: v0.0.3 sha256=aaa
  remote:  v0.0.3 sha256=bbb
  reason: checksum changed

Update qdm-cmr-cli? [yes/skip]
```

不同安装模式下的差异：

- GitHub Token 自动模式：installer 可以访问远程仓库、下载 release asset、校验 checksum，并自动完成用户确认的更新项。
- 本地路径模式：installer 不替用户下载私有资源；如果发现本地路径组件可能不是最新版本，只提示用户需要手动替换对应路径，然后继续下一项。

安装阶段默认构建 wikis 索引，但使用放宽参数：

```bash
data-harness-cli wikis build-index --skip-checks
```

`--skip-checks` 是 `data-harness-cli wikis build-index` 已支持的参数，用于跳过构建前的 `check-all`。使用该参数时，CLI 会输出 warning，并在索引元信息中记录 `checksSkipped: true`。

即使带上 `--skip-checks`，如果遇到无法可靠构建索引的硬错误，例如 frontmatter 无法解析、文件无法读取或召回词重复，命令仍应失败。

安装器默认带上 `--skip-checks`，原因是第一版安装器应尽量放宽，避免完整 Wiki 规范检查阻塞用户完成基础安装。

如果安装阶段 `build-index --skip-checks` 失败，installer 不应直接终止整个安装；应输出失败原因，并提示用户后续手动重新执行：

```bash
data-harness-cli wikis build-index --skip-checks
```

如果后续 context 运行发现索引不存在，可以由 `data-harness-cli` 自己回退、提示或按需生成。

如果任一项实际完成了更新，最后应尝试重新执行：

```bash
data-harness-cli wikis build-index --skip-checks
data-harness-cli doctor
```

更新后的 `wikis build-index --skip-checks` 如果失败，不应回滚已经完成的 CLI 更新；installer 应输出错误原因，并提示用户后续手动重新执行。

## Doctor 检查项

doctor 应围绕 runtime 是否可用检查，而不是检查源码仓库是否存在。

检查项：

- runtime 目录存在。
- `bin/data-harness-cli` 可执行。
- `bin/qdm-cmr-cli` 可执行。
- `bin/qdm-indicators-cli` 可执行。
- `bin/cas-cli` 可执行。
- 如果使用本地路径模式，记录的 `cas-cli`、`qdm-indicators-cli`、`qdm-cmr-cli` 原始路径仍存在且可执行。
- `wikis/spec`、`wikis/playbooks`、`wikis/templates` 存在。
- 如果使用本地路径模式，记录的 `harness-data-wikis` 原始路径仍存在。
- `config/harness-config.yaml` 存在。
- `config/qdm-cli-paths.env` 存在。
- config 中 CLI 路径有效。
- `.qdm-auth/cas/config.json` 存在且结构有效。
- CMR token 有效。
- Indicators token 有效。
- 按用户选择，`<runtime-dir>/.claude`、`<runtime-dir>/.codex` 或 `<runtime-dir>/.pi` 已正确软链到 `<runtime-dir>/agents/*`。

可选提示项：

- `.harness/index/wikis-index.json` 是否存在；不存在时只提示用户可执行 `data-harness-cli wikis build-index --skip-checks`，不作为 doctor 失败条件。

不再检查：

- `bootstrap/cli-manifest.json` 是否存在于源码 checkout。
- `harness-data` main repo commit。
- `harness-data` worktree dirty 状态。

如需要记录版本，可在 runtime state 中记录：

```json
{
  "runtimeVersion": "0.0.5",
  "dataHarnessCliVersion": "0.0.5",
  "installMode": "github-token",
  "wikisRef": "...",
  "manifestSha256": "...",
  "lastCheckAt": "..."
}
```

## 迁移步骤

第一阶段：调整文档和概念

- README 明确用户安装的是 runtime，不是源码仓库。
- npm README 删除“clone/reuse Harness Data workspace”的表述。
- doctor/update/install 文案从 workspace 改为 runtime。

第二阶段：发布 runtime bundle

- release workflow 增加 `harness-data-runtime-<version>.tar.gz`。
- bundle 包含 `agents/`、config examples、manifest。
- npm installer 下载并展开 runtime bundle。

第三阶段：installer 不再 clone `harness-data`

- 删除 `prepareWorkspace` 中 clone `harness-data` 的路径。
- 改为 `prepareRuntimeDir`。
- `wikis` 单独 clone 或下载。
- agent 配置软链到 runtime 根目录。

第四阶段：兼容旧安装

- `doctor` 可以识别旧的 harness-data workspace。
- `update` 可以提示迁移到 runtime 目录。
- 迁移命令可把旧 workspace 中的 `config`、`.harness/state`、CAS 配置复制到新 runtime。

## 最终目标

用户只需要理解：

```text
我安装了 Harness Data CLI runtime。
我在 runtime 目录里启动 Agent，就能接入 QDM 分析能力。
```

用户不需要理解：

```text
harness-data 源码仓库是什么。
cli/、npm/、tests/、plan/、.github/ 这些目录有什么用。
```

`harness-data` 仓库继续作为开发和发布载体存在，但不再是用户安装和使用入口。
