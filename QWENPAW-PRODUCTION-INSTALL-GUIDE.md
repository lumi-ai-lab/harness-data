# QwenPaw 适配说明

> 当前状态：源代码适配层保留，尚未纳入 Harness Data 的正式用户发布渠道。

Harness Data 当前正式安装路径是 Codex Plugin：

```text
主 GitHub 仓库 → lumi-ai-lab Marketplace → harness-data Plugin → scripts/setup.mjs
```

QwenPaw 的宿主适配代码仍可在同一仓库中维护和测试，但本文件不再提供独立 runtime、Wiki 包、容器或 npm 安装步骤。后续如果 QwenPaw 形成正式 Plugin 协议，应补充：

- 宿主 Plugin manifest 和安装入口；
- 显式 Root Context handoff；
- workspace allowlist 重复校验；
- secret handoff 和权限边界；
- state/report 路径；
- clean install、reload 和卸载验收。

在这些契约确定前，请不要把旧的本地 runtime 安装方式用于新的 Harness Data 部署。
