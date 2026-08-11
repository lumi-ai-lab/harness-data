# WorkBuddy Windows 鉴权 fix2 回归结果

## 结论

2026-08-11，`0.0.44-e2e.20260811.fix2` 已在 Windows WorkBuddy 5.3.8 完成回归。操作者确认第四、第五步及其全部验收项通过；仓库侧离线检查、Spy 契约、真实 CLI 离线 broker 和包隔离检查也全部通过。因此，WorkBuddy 5.3.8+ 的第一阶段 Local Blob 鉴权宿主契约可以解除生产门槛。

本结论只覆盖管理员显式分发的 Local Blob + userId，不表示继承 WorkBuddy 登录身份。

## 验证基线

- 分支：`feat/windows-workbuddy-auth`
- 基线提交：`89526f6ef50798c7663b3e0af4fe9373d04a13f9` + 当前工作树修复
- WorkBuddy：5.3.8 / Windows
- E2E 版本：`0.0.44-e2e.20260811.fix2`
- 公共 Marketplace ZIP SHA-256：`7a5f865cb7d295188661a8e3980245081cf8ed1119f1a5d28a4c29ac0df91013`
- authz-on-real ZIP SHA-256：`1d26a73426359e6c1904fb62d920f8a4888174b8a221400b36102f6ef51896d5`
- 完整包校验：`D:\Repos\harness-data-workbuddy-e2e-20260811\checksums.sha256`

## 已通过项目

1. Bash tool 的 `auth describe --resolve-labels=false` 返回真实 JSON；主体为 `local-test-user`，`enabled=true`、`labelsResolved=false`。
2. Bash tool 的受控命令被替换为无 blob 的 `data-harness-cli authz-exec --agent workbuddy -- ...`。
3. 模型提供的 `--data-auth`、`--auth-blob`、`--auth-json` 被剥离，可信 Local Blob 在 broker 进程内注入。
4. WorkBuddy PowerShell 的受控 QDM 命令在授权解析前 deny，错误码为 `QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED`，不返回 `updatedInput`，不执行原命令。
5. `analysis execute` 的 Bash stdout/stderr 与退出码可由 WorkBuddy 正常获得。
6. missing/invalid blob 保持执行前 deny 和零副作用。
7. authz-off 保持 no-op，不调用 broker。
8. 五个 fix2 ZIP 的 checksum、解压结构、插件版本、CLI hash 和隔离规则全部通过；包内不含 `.workbuddy`、`.harness/state` 或历史 `e2e-results`。

## 会话安全扫描

对 `C:\Users\QDM\.workbuddy\projects` 下与 `retest-fix2` 对应的会话做精确值扫描，未输出或复制会话内容：

- WorkBuddy project 目录：3
- session JSONL：8
- 精确 runtime blob 命中文件：0
- 包含 broker 执行证据的文件：5
- 包含 PowerShell fail-closed 证据的文件：2

未将真实 blob、会话 JSONL、WorkBuddy 日志或业务查询结果提交到仓库。

## 发布决定

- `workBuddyAuthzHostContractValidated` 可以改为 `true`。
- 最低支持版本以实际验证基线收紧为 WorkBuddy 5.3.8。
- 可以允许显式 `--agent workbuddy --data-auth`。
- Windows 默认 Agent 仍为 Codex；`all` 与 `both` 的既有语义不变，WorkBuddy 继续要求显式选择。
- installer/doctor 门槛解除后，正式 npm 产物的干净 runtime 安装验收已通过，可以提交发布。

## 正式 npm 安装路径验收

使用当前工作树执行 `npm pack`，从生成的 `lumi-ai-lab-harness-data-0.0.44.tgz` 在全新临时 runtime 中完整运行：

```text
install --agent workbuddy --data-auth --yes
doctor --agent workbuddy --work-buddy-version 5.3.8 --json
```

结果：

- npm tarball SHA-256：`09c54618e3e716822f9b5a2e06cf0cccaed3b5b7c3f6e0a0562adbfb43841415`
- install：通过，生成 `authz.mode=on` 并复制本地测试 blob。
- Wikis index：通过，`docs=1405`、`recall=1703`、`runtimeDocs=1405`。
- doctor：0 个失败项，host contract 为通过，最低版本为 5.3.8。
- Bash 离线 `auth describe --resolve-labels=false`：allow；`local-test-user`、`enabled=true`、`labelsResolved=false`；输出不含 blob。
- PowerShell gated `auth describe`：deny；`QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED`；无 `updatedInput`。
- GitHub/Provider 网络访问：无。

机器可读结果保存在 `D:\Repos\harness-data-workbuddy-e2e-20260811\production-acceptance-fix2\RESULT.json`。
