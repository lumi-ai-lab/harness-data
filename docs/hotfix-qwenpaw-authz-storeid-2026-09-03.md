# QwenPaw authz-hook 门店过滤热修复部署文档

| 项 | 值 |
|---|---|
| 日期 | 2026-09-03 |
| 状态 | **已上线并通过生产模式验证** |
| 目标容器 | `qwenpaw`（镜像 `harness-data-qwenpaw:0.0.56-amd64`） |
| 源码提交 | `harness-data` `8889719`（本地，未推送） |
| 部署脚本 | `deploy/qwenpaw/hotfix-authz-hook.sh`（本地，未入库） |

## 1. 背景与问题

QwenPaw 机器人查询门店 `101001`（广州骏景一店）2026-09-02 的 `saleAmt`，
返回 `QDM_STORE_OUTSIDE_DATA_SCOPE`（门店超出数据范围）；同一查询用
`qdm-metric-cli` 在容器内直跑返回 `saleAmt=11651.96`，数据本身存在。

即问题出在鉴权预检层，不在数据层。

## 2. 根因

Harness `authz-hook` 预检（`packages/data-harness-cli/src/lib/authz/hook.js`
的 `normalizeQwenPawFilters`）对带 contract 的维度要求
`scope.dataScope[dimension]` 中有授权条目，`storeId` 维度不在其中时抛
`QDM_STORE_OUTSIDE_DATA_SCOPE`。

但 authz-v2 协议的 scope 里**从来不含 `storeId`**——门店授权以区域维度
（`sapArea2Id` / `manageAreaId`）承载。因此任何带 `storeId` 过滤的查询都会
在预检阶段被误拒，除非用户恰好被授予了某个具体门店的 scope（协议不提供）。

## 3. 修复方案

`storeId` 过滤**无条件透传**，不在 hook 预检层做门店粒度校验；门店链约束
由 `qdm-metric-cli`（Go）在预检之后强制执行：

- 用户持有 `sapArea2Id`/`manageAreaId` 区域权限时，CLI 注入区域过滤，
  查询同时受区域与门店条件约束；
- 用户不持有区域权限时，CLI 的 `authorizationChainsAvailable`（
  `cmd/qdm-metric-cli/analysis_command.go:344,418`、
  `ui_command.go:334`）拒绝 store 链查询（`AUTHORIZATION_FAILED`），
  即使 hook 已透传也不会执行。

## 4. 代码变更

提交 `8889719`（amend 自 `1fdfc4a`），作者 yaw0110，共 2 个文件
（+22/-2）：

```diff
@@ packages/data-harness-cli/src/lib/authz/hook.js @@
     const entries = scope.dataScope[dimension];
     if (!entries || !entries.length) {
+      // qdm-metric-cli carries store authorization as sapArea2Id /
+      // manageAreaId and rejects store-chain queries when the user lacks
+      // that scope, so the concrete store filter is passed through and the
+      // CLI enforces the final constraint after this preflight.
+      if (dimension === "storeId") {
+        normalized[dimension] = values.map(String);
+        continue;
+      }
       throw new QwenPawDeny(contract.code, contract.message);
```

- `packages/data-harness-cli/src/lib/authz/hook.js`：+8 行透传逻辑
- `packages/data-harness-cli/test/authz-hook.test.js`：+16/-2 回归断言

配套测试（qdm-metric-cli，提交 `4c86cf27`）：
`TestApplyAuthorizationKeepsStoreScopeWhenSKUAndStoreAreSelected` /
`TestApplyAuthorizationRejectsUnavailableSelectedChain` /
`TestApplyAuthorizationAllowsCategoryOnlyScope` 全部通过。

> 注：`qdm-metric-cli/docs/qwenpaw-authz-hook-store-scope.md` 中引用的
> harness 提交号 `1fdfc4a` 已 amend 为 `8889719`，内容一致。

> **后续重构（2026-09-04）**：提交 `756123a` 将 `QWENPAW_SCOPE_DIMENSIONS`
> 收敛为 authz-v2 实际在用的三个维度（`categoryLevel1Id` / `sapArea2Id` /
> `dcSapArea2Id`），并删除上方的 `storeId` 特判——`storeId` 不在契约表时
> 走通用透传分支，行为与本节方案完全一致。已部署容器文件仍为旧版
> （功能等价），待下次插件镜像部署后收敛。

## 5. 构建

```bash
cd /Users/jhyan/qdm/harness-data
node scripts/build-qwenpaw-plugin.mjs --verify
```

`--verify` 重新从源码组装 `dist/qdm-harness-qwenpaw/` 但不打包 zip。
构建后确认产物与源码字节一致：

```bash
cmp dist/qdm-harness-qwenpaw/dist/data-harness-cli/src/lib/authz/hook.js \
    packages/data-harness-cli/src/lib/authz/hook.js   # 无输出即一致
```

产物版本 `v0.1.6`。部署脚本 `preflight` 也会做这层一致性检查，过期文件会被拒绝。

## 6. 生产环境关键路径

| 项 | 路径 / 值 |
|---|---|
| 容器 | `qwenpaw`（`harness-data-qwenpaw:0.0.56-amd64`） |
| 插件根 | `/app/working/plugins/qdm-harness-qwenpaw/`（无 `config/` 目录） |
| 实例根（生产配置） | `/opt/qdm/harness-data/instance/0.0.56/` |
| 鉴权配置 | `/opt/qdm/harness-data/instance/0.0.56/config/harness-config.yaml`（`authz: mode: on`、`qdm_metric_cli` 指向 runtimes 下二进制） |
| Root Context | `/opt/qdm/harness-data/instance/0.0.56/context.json`（来自 `/etc/qdm/qwenpaw/plugin-config.json` 的 `root_context_path`） |
| 目标替换文件 | `/app/working/plugins/qdm-harness-qwenpaw/dist/data-harness-cli/src/lib/authz/hook.js` |
| CLI 调用入口 | `/app/working/plugins/qdm-harness-qwenpaw/scripts/data-harness-cli`（755） |
| 渠道材料 | `/run/secrets/channel-auth.json`（wecom 用户 `yanjianhao` 等） |
| Node | v18.20.4 |

生产调用链（Python `qdm_cli.py` `authorize()` 子进程）：

```text
[harness] [--context-file /opt/qdm/harness-data/instance/0.0.56/context.json]
          authz-hook --agent qwenpaw --format adapter-envelope
payload: {"tool_name":"qdm_query","tool_input":<query>,"blob":<channel ciphertext>}
```

**必须带 `--context-file`**：不带时 hook 读到插件根目录（无
`harness-config.yaml`），鉴权默认 `disabled`，预检形同虚设。

## 7. 部署

### 7.1 脚本用法

```bash
cd /Users/jhyan/qdm/harness-data
QDM_SSH_PASSWORD=xxx ./deploy/qwenpaw/hotfix-authz-hook.sh            # deploy(默认)
QDM_SSH_PASSWORD=xxx ./deploy/qwenpaw/hotfix-authz-hook.sh verify     # 仅授权验证
QDM_SSH_PASSWORD=xxx ./deploy/qwenpaw/hotfix-authz-hook.sh rollback   # 回滚
QDM_SSH_PASSWORD=xxx ./deploy/qwenpaw/hotfix-authz-hook.sh inspect    # 只读查看
```

密码只走环境变量不落盘；服务器与跳板机同密码。SSH 无密钥，跳板链为
`yanjianhao@hnbh.qdama.cn:60022` → `ztadmin@10.111.105.15:8166`。

### 7.2 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `QDM_SSH_PASSWORD` | 无（必填） | 跳板机/目标机密码 |
| `QDM_SSH_HOST` | `ztadmin@10.111.105.15` | 目标机 |
| `QDM_SSH_PORT` | `8166` | 目标机端口 |
| `QDM_SSH_JUMP` | `yanjianhao@hnbh.qdama.cn:60022` | 跳板机 |
| `QDM_CONTAINER` | `qwenpaw` | 目标容器 |
| `QDM_CONTEXT_FILE` | `/opt/qdm/harness-data/instance/0.0.56/context.json` | Root Context（verify 用） |

### 7.3 deploy 步骤

1. `preflight`：本地 dist 存在、含透传标记 `rejects store-chain queries`、
   dist 与源码一致、`node --check` 通过；
2. ssh stdin 上传到服务器 `/tmp/qdm-authz-hook.js`（不用 scp，见 §9）；
3. `docker cp` 进容器 `/tmp/`；
4. 一次性备份原文件到 `/tmp/qdm-authz-hook.js.orig`；
5. `install -m 0444` 写 `.new` + `node --input-type=module --check` +
   `chown --reference` 保留 `qwenpaw:qwenpaw` + 原子 `mv -f`；
6. 容器内自检：语法、标记、属主/权限。

**无需重启**：hook 每次调用以子进程方式执行，文件替换即刻生效。

### 7.4 已部署状态（2026-09-03）

```
-r--r--r-- 1 qwenpaw qwenpaw 24483 Sep  3 23:37 .../authz/hook.js   # 修复版
-r--r--r-- 1 qwenpaw qwenpaw 24085 Sep  3 13:48 /tmp/qdm-authz-hook.js.orig  # 旧版备份
marker-present
```

## 8. 验证

### 8.1 生产模式授权预检（通过）

按 §6 的生产调用链执行（payload 取自 wecom `yanjianhao` 的渠道密文，
查询 `storeId=101001` 的 `saleAmt`）：

```json
{"schemaVersion":1,"status":"allow",
 "hookOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",
   "scope":{"enabled":true,"capabilities":["qdm.metric.query"],"labelsResolved":true,
     "dataScope":{"categoryLevel1Id":[...],"dcSapArea2Id":[...],"sapArea2Id":[...]}}},
 "normalizedFilters":{"storeId":["101001"]}}
```

关键点：`status=allow`，且 `normalizedFilters.storeId` 已透传——旧版在这里
会抛 `QDM_STORE_OUTSIDE_DATA_SCOPE`。最终门店链约束由 CLI 兜底。

### 8.2 容器日志

```bash
docker logs --since 10m qwenpaw 2>&1 | grep -E 'QDM_STORE_OUTSIDE_DATA_SCOPE|qdm_query_failed'
```

无新增命中。

### 8.3 回归（qdm-metric-cli）

`go test ./...`（`TestApplyAuthorization*` 系列）通过，覆盖：
SKU+门店同选时保留门店过滤、无区域权限时拒绝 store 链、仅类目权限放行。

## 9. 回滚

```bash
QDM_SSH_PASSWORD=xxx ./deploy/qwenpaw/hotfix-authz-hook.sh rollback
```

从容器内 `/tmp/qdm-authz-hook.js.orig` 恢复：同样的 `install` +
`node --check` + 原子 `mv`，随后自检确认 `marker-gone`。旧文件 24085 字节，
包含 `storeId: { code: "QDM_STORE_OUTSIDE_DATA_SCOPE" }` 原拒绝逻辑。

## 10. 注意事项

1. **热补丁是临时的**：容器重启、`run_docker.sh` 重跑或镜像重新部署都会
   还原成镜像内旧文件。正式修复需随插件镜像发布（源码已就绪：`8889719`
   已推送 `yaw0110:fix/authz-storeid-passthrough`，PR #83）。
2. **提交已随 PR 入库**：`8889719` 与部署脚本、本文档均已推送至 fork 分支
   `yaw0110:fix/authz-storeid-passthrough`（PR #83）。
3. **文件上传不用 scp**：macOS 自带 scp 与本地 `HTTP_PROXY` 冲突
   （`Connection closed by 127.0.0.1 port 7890`），脚本改用 ssh stdin 管道。
4. **verify 必须带 `--context-file`**：早期版本漏传导致预检返回
   `"status":"disabled"` 的假阴性，已修复并默认指向生产 Root Context。
5. **密码安全**：仅经环境变量传递，勿写入 shell 历史或脚本文件。

## 11. 相关材料

- 源码修复提交：`harness-data` `8889719`（`fix(authz): 门店过滤透传给 CLI 强制门店链约束`）
- CLI 兜底实现：`qdm-metric-cli` `analysis_command.go` / `ui_command.go`
- CLI 侧设计文档：`qdm-metric-cli/docs/qwenpaw-authz-hook-store-scope.md`
- 部署脚本：`harness-data/deploy/qwenpaw/hotfix-authz-hook.sh`
