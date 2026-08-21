# qdm-metric-cli Gitee 最新槽位

`qdm-metric-cli` 使用固定的 Gitee Release tag：`qdm-metric-cli-latest`。每次镜像会先上传新版本的全部平台附件，全部成功后删除该槽位中的旧附件，并删除历史的 `qdm-metric-cli-vX.Y.Z` Gitee Release。

## 在 qdm-metric-cli 仓库中调用

在私有仓库的 Release workflow 中增加一个 job：

```yaml
  mirror-gitee:
    name: Mirror qdm-metric-cli to Gitee
    needs: release
    uses: lumi-ai-lab/harness-data/.github/workflows/mirror-gitee.yml@master
    with:
      kind: metric-latest
    secrets:
      GITEE_TOKEN: ${{ secrets.GITEE_MIRROR_TOKEN }}
      METRIC_GH_TOKEN: ${{ secrets.METRIC_RELEASE_READ_TOKEN }}
```

`METRIC_RELEASE_READ_TOKEN` 只需要对 `pengmide/qdm-metric-cli` 授予 GitHub `Contents: Read`，用于读取私有 Release；`GITEE_MIRROR_TOKEN` 只用于更新公开 Gitee Release。

也可以在 `harness-data` 仓库手动运行 `Mirror to Gitee` workflow，将 `kind` 选为 `metric-latest`。此时仓库 Secret 中需要配置同名的两个 token。

安装器从 `qdm-metric-cli-latest` 读取附件名称中的版本号，因此 Metric CLI 可以独立于 Harness Data 发版；Harness Data 的 Runtime/Wikis tag 不需要变化。
