# Plugin-first Directory Layout 调研归档与缺口说明

> 历史调研归档。当前产品决定允许 Setup 写入 Plugin Root，并以内置 Wiki 作为运行时资源；请以 [`codex-plugin-layout.md`](codex-plugin-layout.md) 为准。

> 原始调研文件 `handoff-plugin-first-directory-layout-2026-08-29.md` 未在当前工作树、本地 refs、远端 refs 或 Git 的可达/不可达对象中找到。本文是基于当前代码、发布链路和已归档验收证据重建的留证，不是原文恢复。

## 已确认结论

- `pluginRoot` 与 `dataRoot` 必须分离；pluginRoot 默认只读，持久化配置、runtime、state、secret 不得写入其中。
  - `plan.md` 第 1、4 节
  - `docs/root-context-v1.md`
- 新插件必须依赖显式结构化 Root Context；向上寻根只保留给 legacy/迁移兼容。
  - `plan.md` 第 3、5、7 节
  - `docs/root-context-v1.md`
- 发布与安装链路必须同时校验资源版本、artifact 内容和安装器消费内容，不能只搬目录。
  - `plan.md` 第 1.3、11 节
  - `docs/release-validation-v0.0.54.md`
- 旧 runtime 迁移采用 copy + 校验 + pointer，失败时保留旧 runtime 可回滚。
  - `plan.md` 第 12 节
  - `docs/migration-field-validation-2026-08-29.md`

## 无法恢复的原始内容

以下信息无法从 Git 历史恢复，因此不能声称本文等价于原 handoff 原文：

- 原始作者和完整推理过程；
- 宿主逐项调研时使用的外部来源；
- 未进入当前代码、文档或测试产物的反例和命令输出。

## 当前仍未覆盖

- Codex 升级/回滚、生产 secret provider、桌面客户端 reload；
- 其他 Agent 适配层的 Phase 5 实机验收；
- Windows secret handoff/ACL 和宿主 secret API 的生产级验证。

这些事项仍以 `plan.md` 第 20.1、20.7、20.8 节为准，本文不把模拟 fixture 或文件 secret 回归测试升级为生产宿主证据。

## 归档依据

- `docs/root-context-v1.md`
- `docs/root-context-threat-model.md`
- `docs/migration-field-validation-2026-08-29.md`
- `docs/release-validation-v0.0.54.md`
- 当前分支已合并的双根插件化与迁移实现及其 CI 验收记录
