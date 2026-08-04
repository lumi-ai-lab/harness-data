# 鉴权修复部署文档

## 1. 部署目标

本次修复目标是阻断 Agent 绕过 `qdm-metric-cli` 授权包装器直接调用真实指标 CLI。

核心要求：

- Agent 可见、可执行的公开入口只保留 `/workspace/bin/qdm-metric-cli`。
- `qdm-metric-cli-real` 不再安装到 `/workspace/bin`，改为安装到 Agent 不可见或不可执行的私有目录。
- Pi 扩展禁止模型通过 Bash 直接调用 `qdm-metric-cli-real`。
- Pi 扩展禁止模型通过 Bash 直接调用 `data-harness-cli authz-bind`，避免 `bindingBase64url` 进入模型上下文。
- 未授权范围，例如用户只有 `CN01` 权限却查询 `CN18`，必须 fail-closed。

## 2. 部署拓扑

推荐链路：

```text
WeCom 用户
   |
   v
Lumi / Pi Agent
   |
   v
Pi extension
  - 模型上下文只暴露授权摘要
  - bindingBase64url 留在扩展内部
  - Bash 执行前注入 HARNESS_AUTHZ_BINDING_V1
   |
   v
/workspace/bin/qdm-metric-cli
  - 校验 binding
  - 读取 requester context
  - 校验 manageAreaId / categoryLevel1Id scope
   |
   +-- 未授权 filter -> exit 77
   |
   +-- 已授权 filter
          |
          v
   /opt/harness-data/private/bin/qdm-metric-cli-real
```

禁止链路：

```text
Agent Bash
   |
   +-- /workspace/bin/qdm-metric-cli-real
   |      |
   |      v
   |   文件不存在，Pi Bash override 也会 fail-closed
   |
   +-- /opt/harness-data/private/bin/qdm-metric-cli-real
   |      |
   |      v
   |   非 root Agent: Permission denied
   |
   +-- alias / symlink / sss -> qdm-metric-cli-real
   |      |
   |      v
   |   非 root Agent: Permission denied
   |
   +-- data-harness-cli authz-bind
          |
          v
       Pi Bash override: exit 9
```

## 3. 版本与提交

当前本地修复提交：

```text
18fb438 feat(installer): 私有化 real Metric CLI 安装路径
33e3a83 fix(authz): 从安装状态加载私有 real CLI 路径
67afce3 fix(pi): 禁止模型通过 Bash 调用 authz-bind
fbbb216 chore(release): 补充 linux-arm64 授权运行时校验
```

涉及行为：

- manifest 中 `qdm-metric-cli-real` 标记为 `private: true`。
- `qdm-metric-cli-real` 默认安装到 `.harness/private/bin/qdm-metric-cli-real`。
- Docker 部署建议使用 `--private-tools-dir /opt/harness-data/private/bin`。
- installer-state 升级为 `schemaVersion: 4`。
- Go runtime 从 installer-state 读取 real CLI 私有路径。
- readiness 拒绝 `/workspace/bin/qdm-metric-cli-real` 继续存在。
- Pi Bash override 同时阻断直接引用 `qdm-metric-cli-real` 和 `authz-bind`。

## 4. Docker 部署要求

### 4.1 必须满足的权限边界

有效部署必须满足：

```text
Agent UID != 0
Agent UID 不能读取 /opt/harness-data/private/bin
Agent UID 不能执行 /opt/harness-data/private/bin/qdm-metric-cli-real
/workspace/bin 不存在 qdm-metric-cli-real
Agent PATH 不包含 /opt/harness-data/private/bin
```

推荐权限：

```text
/opt/harness-data/private/bin                       0700 root:root
/opt/harness-data/private/bin/qdm-metric-cli-real   0500 root:root
/workspace/bin/data-harness-cli                     0755
/workspace/bin/qdm-metric-cli                       0755
```

### 4.2 Docker Desktop bind mount 限制

不要用 macOS host bind mount 作为私有目录的安全证明。

本地验证发现：

```text
- macOS bind mount 下容器内 chmod/chown 视图可能与 host 视图不一致。
- 非 root 容器进程可能仍能读取或执行看似 root:root 0700/0500 的 bind mount 文件。
- 因此 Docker Desktop bind mount 只能用于功能调试，不能作为 Linux 文件权限隔离的安全边界证据。
```

本地验证应使用 Docker named volume 或镜像内路径。

### 4.3 Lumi sandbox root 限制

当前本地 Lumi sandbox 镜像默认用户是 root：

```text
uid=0(root) gid=0(root) groups=0(root)
```

如果 Agent Bash 或 device executor 以 root 运行，则 Unix mode bits 不能隐藏私有 real CLI。root 仍然可以直接执行：

```text
/opt/harness-data/private/bin/qdm-metric-cli-real
```

所以生产部署必须二选一：

```text
方案 A：Agent/device executor 改为非 root 运行
  - real CLI 放在 root/private 用户拥有的私有目录
  - Agent 只读 requester context，只能执行 public wrapper

方案 B：real CLI 不进入 Agent 容器
  - sidecar/broker 持有 real CLI
  - public wrapper 或授权服务只发送已校验的结构化请求
  - broker 不接受 Agent 提交的任意 raw CLI 命令
```

当前代码已完成第一阶段“real CLI 私有化 + 模型侧阻断”，但同容器非 root 场景下如果要让授权查询成功执行 real CLI，还需要 broker/helper/sidecar 承担特权执行。否则会出现：

```text
fork/exec /opt/harness-data/private/bin/qdm-metric-cli-real: permission denied
```

这不是授权绕过，而是第一阶段权限边界生效后的执行链路缺口。

## 5. 安装命令

本地验证目录：

```text
/Users/jhyan/qdm/workspace-auth-test
```

Docker named volume：

```bash
docker volume create harness-auth-private-20260805011224
```

安装命令模板：

```bash
docker run --rm --platform linux/amd64 \
  -v /Users/jhyan/qdm/worktree/harness-data-debug-permission-20260804:/repo:ro \
  -v /Users/jhyan/qdm/workspace-auth-test:/workspace \
  -v harness-auth-private-20260805011224:/opt/harness-data/private/bin \
  -v /tmp/harness-auth-fix-local-build.AzzD0w:/build:ro \
  -w /repo \
  -e QDM_METRIC_CONTRACT_ASSETS=/build/qdm-metric-release \
  -e HOME=/tmp/harness-home \
  -e PATH=/build/fake-gh:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  node:22-bookworm \
  node npm/bin/harness-data.js install \
    --dir /workspace \
    --profile pi-requester-authorized \
    --agent pi \
    --yes \
    --runtime-bundle /build/dist/harness-data-runtime-v0.0.35.tar.gz \
    --runtime-tag v0.0.35 \
    --asset-dir /build/dist \
    --private-tools-dir /opt/harness-data/private/bin
```

生产使用 npm release 时，不需要 `--runtime-bundle` 和 `--asset-dir`：

```bash
npx @lumi-ai-lab/harness-data install \
  --dir /workspace \
  --profile pi-requester-authorized \
  --agent pi \
  --yes \
  --private-tools-dir /opt/harness-data/private/bin
```

## 6. 部署后检查

### 6.1 installer-state

命令：

```bash
node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync("/workspace/.harness/installer-state.json","utf8"));
console.log(JSON.stringify({
  schemaVersion:s.schemaVersion,
  profile:s.profile,
  agent:s.agent,
  releaseSet:{key:s.releaseSet.key,platform:s.releaseSet.platform},
  tools:Object.fromEntries(Object.entries(s.tools).map(([k,v])=>[k,{version:v.version,destination:v.destination}]))
},null,2))
'
```

期望：

```json
{
  "schemaVersion": 4,
  "profile": "pi-requester-authorized",
  "agent": "pi",
  "releaseSet": {
    "key": "pi-requester-v1",
    "platform": "linux-amd64"
  },
  "tools": {
    "data-harness-cli": {
      "version": "v0.0.35",
      "destination": "/workspace/bin/data-harness-cli"
    },
    "qdm-metric-cli": {
      "version": "v0.0.35",
      "destination": "/workspace/bin/qdm-metric-cli"
    },
    "qdm-metric-cli-real": {
      "version": "v0.1.0",
      "destination": "/opt/harness-data/private/bin/qdm-metric-cli-real"
    }
  }
}
```

### 6.2 公开 bin 目录

命令：

```bash
ls -l /workspace/bin
ls -l /workspace/bin/qdm-metric-cli-real
echo public_real_rc=$?
```

期望：

```text
data-harness-cli
qdm-metric-cli
ls: cannot access '/workspace/bin/qdm-metric-cli-real': No such file or directory
public_real_rc=2
```

### 6.3 非 root Agent 直调 real CLI

命令：

```bash
docker run --rm --platform linux/amd64 --user 1000:1000 \
  -v /Users/jhyan/qdm/workspace-auth-test:/workspace:ro \
  -v harness-auth-private-20260805011224:/opt/harness-data/private/bin:ro \
  -w /workspace \
  node:22-bookworm \
  sh -lc '
    export PATH=/workspace/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    id
    ls -l /workspace/bin/qdm-metric-cli-real
    echo public_real_rc=$?
    command -v qdm-metric-cli-real
    echo lookup_real_rc=$?
    stat -c "%A %a %u %g %n" /opt/harness-data/private/bin /opt/harness-data/private/bin/qdm-metric-cli-real
    echo private_stat_rc=$?
    /opt/harness-data/private/bin/qdm-metric-cli-real version
    echo direct_rc=$?
    ln -sf /opt/harness-data/private/bin/qdm-metric-cli-real /tmp/sss
    /tmp/sss version
    echo symlink_rc=$?
    qdm-metric-cli version
    echo wrapper_rc=$?
  '
```

期望关键输出：

```text
uid=1000(node) gid=1000(node) groups=1000(node)
ls: cannot access '/workspace/bin/qdm-metric-cli-real': No such file or directory
public_real_rc=2
lookup_real_rc=127
drwx------ 700 0 0 /opt/harness-data/private/bin
stat: cannot statx '/opt/harness-data/private/bin/qdm-metric-cli-real': Permission denied
private_stat_rc=1
sh: 1: /opt/harness-data/private/bin/qdm-metric-cli-real: Permission denied
direct_rc=126
sh: 1: /tmp/sss: Permission denied
symlink_rc=126
qdm-metric-cli authorization denied (authz_config_invalid): LUMI_REQUESTER_CONTEXT_DIR is required
wrapper_rc=77
```

结论：

```text
alias/symlink 不能越过文件系统权限边界。
wrapper 在没有 requester context 时 fail-closed。
```

## 7. 回滚方案

如需回滚本次修复：

```bash
git revert fbbb216
git revert 67afce3
git revert 33e3a83
git revert 18fb438
```

回滚风险：

```text
回滚后 qdm-metric-cli-real 可能重新进入 /workspace/bin，Agent 可通过 real CLI 绕过授权包装器。
除非有 sidecar/broker 替代方案，否则不建议在生产环境回滚。
```

## 8. 发布前门禁

发布前必须通过：

```bash
cd /Users/jhyan/qdm/worktree/harness-data-debug-permission-20260804/npm
npm test

cd /Users/jhyan/qdm/worktree/harness-data-debug-permission-20260804
node --test .agents/pi/extensions/qdm-harness/test/*.mjs
go test ./cli/internal/authz ./cli/internal/metriccli ./cli/cmd/data-harness-cli ./cli/cmd/qdm-metric-cli
```

门禁期望：

```text
npm test: 38 pass, 0 fail
Pi extension tests: 41 pass, 1 skipped, 0 fail
Go authz/metriccli/cmd tests: pass
```

