# QwenPaw 适配说明

> 当前状态：QwenPaw 插件已完成架构对齐(artifactRoot/instanceRoot 分离、Root Context 契约、
> 原生 ZIP 发布形态)。实机验收(`make plugin-init-qwenpaw-dev`)与正式发布渠道的接入
> 见文末「发布与验收状态」。

Harness Data 正式发布渠道(2026-09 起):

```text
GitHub Release vX.Y.Z
├── harness-data-codex-marketplace-vX.Y.Z.zip    (Codex 插件)
├── harness-data-qwenpaw-plugin-vX.Y.Z.zip       (QwenPaw 原生插件)
└── harness-data-wikis-vX.Y.Z.zip                (私有 Wiki, 两个宿主共用, 加密)
```

## 安装

QwenPaw 用户下载 `harness-data-qwenpaw-plugin-vX.Y.Z.zip` 后：

```bash
# 1. 解压(或直接用 release URL 交给 QwenPaw 安装)
unzip harness-data-qwenpaw-plugin-vX.Y.Z.zip -d qwenpaw-plugin
qwenpaw plugin install qwenpaw-plugin            # QwenPaw 原生安装, 装到 ~/.qwenpaw/plugins/<id>/

# 2. 运行插件自带 Setup(一次性): 下载 Wiki + qdm-metric-cli, 建立实例目录
harness-data qwenpaw setup \
  --source qwenpaw-plugin \
  --wikis-source <本地 wikis 目录或省略以走 Release 下载> \
  --metric-cli <本地 qdm-metric-cli 或省略以走下载> \
  --auth-blob-file <QDM auth.blob> --auth-user-id <用户 ID>
```

完成后插件通过引用模型 `plugin-config.json` 指向 Root Context(instanceRoot), 工作区不再存放
任何 Harness 资源。

## 目录契约

```text
~/.qwenpaw/plugins/qdm-harness-qwenpaw/         ← artifactRoot, 宿主只读, 升级时整体替换
~/.qdm/harness-data/instance/<version>/          ← instanceRoot(resourceRoot)
    resources/wikis/  runtimes/  config/  .harness/index/  context.json  manifests
~/.qdm/harness-data/data/state/...               ← dataRoot, 跨版本
~/.qwenpaw/workspaces/<agent>/agent.json         ← 仅宿主注册指针
```

## 生命周期

```bash
harness-data qwenpaw setup        # 安装/重装(原生 install + instanceRoot + 引用配置)
harness-data qwenpaw doctor --json  # 结构化检查
harness-data qwenpaw update       # 升级(旧 instance 保留用于回滚)
```

卸载默认只移除宿主注册, 数据与 secret 清理需显式确认。

## 开发

```bash
make plugin-init-qwenpaw-dev      # 隔离环境: /tmp/qwenpaw-home/dev-harness-plugin
```

## 发布与验收状态

- [x] 原生 ZIP 构建与校验(`scripts/build-qwenpaw-plugin.mjs`)
- [x] 黄金路径红绿测试 5/5(`.agents/qwenpaw/tests/test_golden_path.py`)
- [x] setup --host qwenpaw / context qwenpaw-hook / authz-hook --agent qwenpaw
- [x] 插件配置引用模型(schema 2)
- [ ] release.yml 发布链路已接入(构建/校验/上传步骤已加, 待首次打 tag 验证)
- [ ] 实机验收: `make plugin-init-qwenpaw-dev` 在真实 QwenPaw 上的 hook/tool/reload/uninstall smoke
- [ ] QwenPaw 侧离线安装本地 zip 的缺陷反馈(QwenPaw `plugin install <zip>` 停止态不可用)
- [ ] QwenPaw-specific migration adapter(`harness-data migrate --host qwenpaw`)
