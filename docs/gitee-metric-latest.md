# Harness/Metric Gitee 组合 Release

Gitee 对外保留一个组合 Release，tag 格式为 `harness-vX.Y.Z-metric-vA.B.C`。每次任一源仓库发版，镜像流程都会复制未变化组件的附件、上传变化组件的附件，校验成功后删除旧组合 Release。

## 在 qdm-metric-cli 仓库中调用

在私有仓库的 Release workflow 中增加一个 job：

```yaml
  mirror-gitee:
    name: Mirror qdm-metric-cli to Gitee
    needs: release
    uses: lumi-ai-lab/harness-data/.github/workflows/mirror-gitee.yml@master
    with:
      kind: composite-metric
    secrets:
      GITEE_TOKEN: ${{ secrets.GITEE_MIRROR_TOKEN }}
      METRIC_GH_TOKEN: ${{ secrets.METRIC_RELEASE_READ_TOKEN }}
```

`METRIC_RELEASE_READ_TOKEN` 只需要对 `pengmide/qdm-metric-cli` 授予 GitHub `Contents: Read`，用于读取私有 Release；`GITEE_MIRROR_TOKEN` 只用于更新公开 Gitee Release。

也可以在 `harness-data` 仓库手动运行 `Mirror to Gitee` workflow，将 `kind` 选为 `composite-metric`。此时仓库 Secret 中需要配置同名的两个 token。

安装器从组合 Release 读取 Runtime、Wikis 和 Metric CLI，因此 Metric CLI 可以独立于 Harness Data 发版；未变化的 Harness Data 附件会被复制到新的组合 Release 中，不需要重新构建。
