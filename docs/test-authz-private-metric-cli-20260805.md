# 鉴权修复本地 Docker/Lumi 测试文档

## 1. 测试结论

测试日期：2026-08-05

测试目录：

```text
/Users/jhyan/qdm/workspace-auth-test
```

代码分支：

```text
debug/permission-issue-20260804
```

结论：

```text
已验证：
1. /workspace/bin/qdm-metric-cli-real 不再存在。
2. Agent PATH 找不到 qdm-metric-cli-real。
3. 非 root Agent 无法 stat、直调或通过 symlink/alias 执行私有 real CLI。
4. qdm-metric-cli 在缺少 requester context 时 fail-closed。
5. CN18 未授权查询被 scope 校验拒绝，返回 exit 77。
6. Pi Bash override 已覆盖 direct real CLI 与 authz-bind 直调。

仍需架构补齐：
1. 同容器非 root Agent 场景下，authorized CN01 查询会在 exec 私有 real CLI 时 Permission denied。
2. 若要同时满足“Agent 不能直调 real CLI”和“授权查询能执行 real CLI”，需要 broker/helper/sidecar。
3. 当前 Lumi sandbox 默认 root；如果 Agent Bash 也是 root，文件权限不能作为安全边界。
```

## 2. 测试链路图

本次验证覆盖的安全边界：

```text
非 root Agent(uid=1000)
   |
   +-- PATH=/workspace/bin:...
   |
   +-- /workspace/bin/qdm-metric-cli
   |      |
   |      +-- 无 context -> fail-closed
   |      |
   |      +-- CN18 -> scope denied
   |      |
   |      +-- CN01 -> scope pass
   |             |
   |             v
   |          exec private real
   |             |
   |             v
   |          Permission denied
   |
   +-- /workspace/bin/qdm-metric-cli-real
   |      |
   |      v
   |   No such file
   |
   +-- /opt/harness-data/private/bin/qdm-metric-cli-real
   |      |
   |      v
   |   Permission denied
   |
   +-- /tmp/sss -> /opt/harness-data/private/bin/qdm-metric-cli-real
          |
          v
       Permission denied
```

## 3. 单元测试

### 3.1 npm 测试

命令：

```bash
cd /Users/jhyan/qdm/worktree/harness-data-debug-permission-20260804/npm
npm test
```

输出摘要：

```text
> @lumi-ai-lab/harness-data@0.0.34 test
> node --test

1..38
# tests 38
# suites 0
# pass 38
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

覆盖点：

```text
manifest publishes the Harness helper, authorized qdm-metric-cli, and private real CLI
Pi requester real Metric CLI resolves only inside the private tools directory
doctor validates the two-CLI runtime and rejects legacy artifacts
release manifest materializer fixes both runtime CLIs
release manifest rejects missing and extra release-set platforms
```

### 3.2 Pi extension 测试

命令：

```bash
cd /Users/jhyan/qdm/worktree/harness-data-debug-permission-20260804
node --test .agents/pi/extensions/qdm-harness/test/*.mjs
```

输出摘要：

```text
1..42
# tests 42
# suites 0
# pass 41
# fail 0
# cancelled 0
# skipped 1
```

跳过项：

```text
Pi 0.83.0 runtime smoke: real createBashTool preserves binding and sanitizes CLI environment
SKIP set QDM_PI_RUNTIME_MODULE to Pi 0.83.0 dist/index.js
```

覆盖点：

```text
commandReferencesRealBinary detects direct real invocation
override blocks direct qdm-metric-cli-real and rewrites to a fail-closed reject
commandReferencesAuthzBind detects direct binding helper invocation
override blocks direct authz-bind so binding material cannot enter Bash output
authorized Pi Bash pins the public Metric CLI and removes forbidden inherited CLI variables
```

### 3.3 Go 授权测试

命令：

```bash
cd /Users/jhyan/qdm/worktree/harness-data-debug-permission-20260804
go test ./cli/internal/authz ./cli/internal/metriccli ./cli/cmd/data-harness-cli ./cli/cmd/qdm-metric-cli
```

输出：

```text
ok  	harness-data/cli/internal/authz
ok  	harness-data/cli/internal/metriccli
ok  	harness-data/cli/cmd/data-harness-cli
?   	harness-data/cli/cmd/qdm-metric-cli	[no test files]
```

说明：

```text
相关授权、Metric wrapper 和 CLI command 包通过。
完整 go test ./cli/... 曾失败在 cli/tests 的 Wikis/recall fixture 场景，
失败信息与本次 real CLI 私有化无直接关系，未作为本次发布门禁。
```

## 4. 本地 Docker 安装验证

Docker named volume：

```text
harness-auth-private-20260805011224
```

安装命令：

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

安装输出：

```text
Harness Data 安装器 0.0.34

安装目录：/workspace
平台：linux-amd64
Profile：pi-requester-authorized

[1/7] 检查本机依赖
通过：git, tar

[2/7] 安装 runtime bundle
使用本地 harness-data-runtime v0.0.35
通过：runtime bundle v0.0.35

[3/7] 安装 CLI 工具
下载 data-harness-cli v0.0.35 (linux-amd64)
下载 qdm-metric-cli v0.0.35 (linux-amd64)
下载 qdm-metric-cli-real v0.1.0 (linux-amd64)
通过：3 个 CLI 已按 pi-requester-authorized profile 安装

[4/7] 同步 Wikis 知识库
通过：已安装发布版本固定的 Lumi Wikis 内容 898d703dbc09

[5/7] 生成本地配置
通过：config/harness-config.yaml
通过：config/qdm-cli-paths.env

[6/7] 构建 Wikis 索引
执行：data-harness-cli wikis build-index --skip-checks
通过：docs=5, recall=0, runtimeDocs=5

[7/7] 配置 Agent Hook
通过：.pi -> agents/pi

安装校验
通过：pi-requester-authorized profile 与 installer-state v4
通过：2 个运行时 CLI（data-harness-cli 与 qdm-metric-cli）
通过：唯一数据入口 qdm-metric-cli
通过：无 CAS/token 与其他数据 CLI
通过：Pi Agent Hook

安装完成：/workspace
```

## 5. 安装状态检查

命令：

```bash
node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync("/Users/jhyan/qdm/workspace-auth-test/.harness/installer-state.json","utf8"));
console.log(JSON.stringify({
  schemaVersion:s.schemaVersion,
  profile:s.profile,
  agent:s.agent,
  installMode:s.installMode,
  releaseSet:s.releaseSet&&{key:s.releaseSet.key,platform:s.releaseSet.platform,realMetricVersion:s.releaseSet.realMetricVersion},
  tools:Object.fromEntries(Object.entries(s.tools||{}).map(([k,v])=>[k,{version:v.version,destination:v.destination,sha256:String(v.sha256||"").slice(0,12)+"..."}]))
},null,2))
'
```

输出：

```json
{
  "schemaVersion": 4,
  "profile": "pi-requester-authorized",
  "agent": "pi",
  "installMode": "github-token",
  "releaseSet": {
    "key": "pi-requester-v1",
    "platform": "linux-amd64",
    "realMetricVersion": "v0.1.0"
  },
  "tools": {
    "data-harness-cli": {
      "version": "v0.0.35",
      "destination": "/workspace/bin/data-harness-cli",
      "sha256": "600c3778b898..."
    },
    "qdm-metric-cli": {
      "version": "v0.0.35",
      "destination": "/workspace/bin/qdm-metric-cli",
      "sha256": "6c5ca6e9369b..."
    },
    "qdm-metric-cli-real": {
      "version": "v0.1.0",
      "destination": "/opt/harness-data/private/bin/qdm-metric-cli-real",
      "sha256": "57d12fd4b2ba..."
    }
  }
}
```

公开 bin 检查：

```bash
ls -l /Users/jhyan/qdm/workspace-auth-test/bin
```

输出：

```text
total 13024
-rwxr-xr-x@ 1 jhyan  staff  3612834 Aug  5 01:04 data-harness-cli
-rwxr-xr-x@ 1 jhyan  staff  3047586 Aug  5 01:04 qdm-metric-cli
```

结论：

```text
/workspace/bin 中不存在 qdm-metric-cli-real。
```

## 6. 非 root Agent 边界测试

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
    echo -- public-bin
    ls -l /workspace/bin
    echo -- public-real
    ls -l /workspace/bin/qdm-metric-cli-real
    echo public_real_rc=$?
    echo -- lookup-real
    command -v qdm-metric-cli-real
    echo lookup_real_rc=$?
    echo -- private-stat
    stat -c "%A %a %u %g %n" /opt/harness-data/private/bin /opt/harness-data/private/bin/qdm-metric-cli-real
    echo private_stat_rc=$?
    echo -- direct-private
    /opt/harness-data/private/bin/qdm-metric-cli-real version
    echo direct_rc=$?
    echo -- symlink
    ln -sf /opt/harness-data/private/bin/qdm-metric-cli-real /tmp/sss
    /tmp/sss version
    echo symlink_rc=$?
    echo -- wrapper-no-context
    qdm-metric-cli version
    echo wrapper_rc=$?
  '
```

输出：

```text
PATH=/workspace/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
uid=1000(node) gid=1000(node) groups=1000(node)
-- public-bin
total 6512
-rwxr-xr-x 1 root root 3612834 Aug  4 17:04 data-harness-cli
-rwxr-xr-x 1 root root 3047586 Aug  4 17:04 qdm-metric-cli
-- public-real
ls: cannot access '/workspace/bin/qdm-metric-cli-real': No such file or directory
public_real_rc=2
-- lookup-real
lookup_real_rc=127
-- private-stat
drwx------ 700 0 0 /opt/harness-data/private/bin
stat: cannot statx '/opt/harness-data/private/bin/qdm-metric-cli-real': Permission denied
private_stat_rc=1
-- direct-private
sh: 1: /opt/harness-data/private/bin/qdm-metric-cli-real: Permission denied
direct_rc=126
-- symlink
sh: 1: /tmp/sss: Permission denied
symlink_rc=126
-- wrapper-no-context
qdm-metric-cli authorization denied (authz_config_invalid): LUMI_REQUESTER_CONTEXT_DIR is required
wrapper_rc=77
```

结论：

```text
非 root Agent 无法通过直接路径、PATH 查找、symlink/alias 访问私有 real CLI。
```

## 7. 授权范围测试

测试 requester scope：

```text
canonicalUserId: yanjianhao
manageAreaIds: [CN01]
categoryLevel1Ids: [10]
botId: [REDACTED]
bindingBase64url: [REDACTED]
```

命令：

```bash
docker run --rm --platform linux/amd64 --user 1000:1000 \
  -v /Users/jhyan/qdm/workspace-auth-test:/workspace \
  -v harness-auth-private-20260805011224:/opt/harness-data/private/bin:ro \
  -w /workspace \
  node:22-bookworm \
  sh -lc '
    export PATH=/workspace/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    export LUMI_REQUESTER_CONTEXT_DIR=/workspace/requester-context/workspace-local/pi
    binding_json=$(data-harness-cli authz-bind --session-id session-local-authz-doc-001)
    binding=$(printf "%s" "$binding_json" | node -e "let s=\"\"; process.stdin.on(\"data\",d=>s+=d); process.stdin.on(\"end\",()=>process.stdout.write(JSON.parse(s).bindingBase64url));")
    export HARNESS_AUTHZ_BINDING_V1="$binding"
    qdm-metric-cli analysis execute --metric saleAmt --filter manageAreaId=CN18
    echo unauth_rc=$?
    qdm-metric-cli analysis execute --metric saleAmt --filter manageAreaId=CN01
    echo auth_rc=$?
  '
```

输出：

```text
-- authz-bind summary
{
  "binding": {
    "version": 1,
    "sessionId": "session-local-authz-doc-001",
    "requestId": "message-local-authz-doc-001",
    "envelopeSha256": "147431a6a57e94ce53f1cfa83277de871875efd62e71d5d14daa109278f947a7",
    "expiresAt": "2026-08-04T18:04:07.341Z"
  },
  "bindingBase64url": "[REDACTED]",
  "summary": {
    "channel": "wecom",
    "botId": "[REDACTED]",
    "canonicalUserId": "yanjianhao",
    "manageAreaIds": [
      "CN01"
    ],
    "categoryLevel1Ids": [
      "10"
    ]
  }
}
-- unauthorized CN18
qdm-metric-cli authorization denied (authz_config_invalid): analysis filter manageAreaId contains an unauthorized value
unauth_rc=77
-- authorized CN01
fork/exec /opt/harness-data/private/bin/qdm-metric-cli-real: permission denied
auth_rc=1
```

结论：

```text
CN18 未授权查询已在 wrapper scope 校验阶段拒绝。
CN01 授权查询通过 scope 校验后进入 real CLI exec 阶段，但因非 root Agent 无权执行私有 real CLI 而失败。
这证明第一阶段修复阻断了越权路径，但也证明生产要完成授权成功链路必须补 broker/helper/sidecar。
```

## 8. Lumi sandbox 验证

本机可运行的 Lumi sandbox 镜像：

```bash
docker run --rm --entrypoint sh ghcr.io/lumi-ai-lab/lumi-sandbox:latest \
  -lc 'id; node -v 2>/dev/null || true; uname -m; command -v device-executor 2>/dev/null || true'
```

输出：

```text
uid=0(root) gid=0(root) groups=0(root)
v22.22.2
aarch64
/usr/local/bin/device-executor
```

结论：

```text
当前本地 Lumi sandbox 默认 root。
如果 Agent Bash 也以 root 执行，私有目录 0700/0500 不能作为安全边界。
必须将 Agent/device executor 切到非 root，或采用 sidecar/broker 方案让 real CLI 不进入 Agent 容器。
```

linux/amd64 Lumi sandbox 拉取失败：

```bash
docker run --rm --platform linux/amd64 ghcr.io/lumi-ai-lab/lumi-sandbox:latest sh -lc 'id'
```

输出：

```text
Unable to find image 'ghcr.io/lumi-ai-lab/lumi-sandbox:latest' locally
docker: Error response from daemon: error from registry: unauthorized
unauthorized
```

说明：

```text
本机只有 arm64/aarch64 Lumi sandbox 可用。
manifest 和 release workflow 已补 linux-arm64 支持，用于 Apple Silicon 本地 Lumi 验证。
```

## 9. 过程问题与修复

### 9.1 macOS tar AppleDouble

现象：

```text
approved Wikis source file set does not match its allowlist manifest
```

原因：

```text
macOS tar 打包时生成 AppleDouble ._* 文件，导致 allowlist 校验失败。
```

处理：

```bash
COPYFILE_DISABLE=1 tar ...
```

### 9.2 Docker Desktop bind mount 文件模式

现象：

```text
open /workspace/wikis/dims/index.md: permission denied
```

host 侧曾看到：

```text
200 /Users/jhyan/qdm/workspace-auth-test/wikis/dims/index.md
```

原因：

```text
fs.cpSync 在 Docker Desktop bind mount 下复制 Wikis 后出现 write-only 文件模式。
```

代码修复：

```text
npm/src/commands/install.js 使用 copyReadableTree 替代 fs.cpSync。
目录按 0755 创建，文件按 0644 写入。
```

## 10. 关闭测试进程

测试完成后执行了 Lumi/Docker 清理。

初始发现：

```text
docker ps:
ghcr.io/lumi-ai-lab/lumi-sandbox:latest  lumi-sandbox-cli-sandbox-wecom-f9403e01  Up 2 days

launchctl list:
com.lumi.llm-bot.wecom
```

停止命令：

```bash
docker stop 761e772b6c9c
kill 57687 57678 2>/dev/null || true
```

发现 Lumi bot 被 launchd 自动拉起后，继续执行：

```bash
launchctl bootout gui/$(id -u)/com.lumi.llm-bot.wecom 2>/dev/null || true
launchctl bootout gui/$(id -u)/com.lumi.llm-bot 2>/dev/null || true
docker stop 1efe77e78918
```

最终复查：

```bash
docker ps --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}'
launchctl list | rg -i 'lumi|llm|wecom' || true
ps -axo pid,ppid,command | rg -i 'lumi|device-executor|workspace-auth-test' || true
```

输出摘要：

```text
无 Lumi sandbox 容器。
无 com.lumi.llm-bot / com.lumi.llm-bot.wecom launchd 项。
无 lumi、device-executor、workspace-auth-test 相关进程。
仅剩 mall-study-* 容器，判断与本次验证无关，未停止。
```

## 11. 风险结论

```text
新版本是否已解决事故中的直接越权问题：
是。公开 real CLI 移除、模型侧 direct real/authz-bind 阻断、wrapper scope 校验使 CN18 越权路径失效。

新版本是否已经形成完整生产闭环：
否。若 Agent 非 root，授权成功查询还需要 broker/helper/sidecar 来执行私有 real CLI；若 Agent root，文件权限边界不成立。

alias/sss=xxx-real 是否会越权：
在非 root + named volume/image layer 私有目录部署下不会，symlink/alias 执行返回 Permission denied。
在 root Agent 场景下仍可能越权，因此 root Agent 不是安全部署形态。
```

