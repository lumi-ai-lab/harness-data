# 复购会员数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取复购会员数（`repurchaseMemberNum`）指标的数据。用户报表使用 `report user` 子命令。
>
> **重要提示**：当前所有数据接口均返回空值或零值，无有效数据。该指标仅在 CLI 返回有值时展示。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code repurchaseMemberNum --full
```

## 二、获取指标值

```bash
qdm-cmr-cli report user indicators --indicator repurchaseMemberNum --display-mode yoyMom
```

当前 `indicators` 子命令不返回该指标值。`area` 返回空 rows。`trend` 返回全零值。

## 三、父级指标

父指标为会员复购率（`memberRepurchaseNoDifferenceRate`），复购会员数作为分子参与计算。会员复购率当前也无有效数据。

## 四、过滤条件

用户报表不支持品类过滤。区域支持标准过滤（`--area-type` / `--area`）。

## 五、注意事项

1. 当前所有数据接口均返回空值或零值，报告生成时应省略此指标。
2. 复购会员数是叶子指标，无下级子指标。
3. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户运营分析页面。