# 复购会员消费频次指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取复购会员消费频次（`memberRepurchaseTranTimes`）指标的数据。用户报表使用 `report user` 子命令。
>
> **重要提示**：当前所有数据接口均返回空值或零值，无有效数据。该指标仅在 CLI 返回有值时展示。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code memberRepurchaseTranTimes --full
```

## 二、获取指标值

```bash
qdm-cmr-cli report user indicators --indicator memberRepurchaseTranTimes --display-mode yoyMom
```

当前 `indicators` 子命令不返回该指标值。`trend` 返回全零值。

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator memberRepurchaseTranTimes
```

当前返回 30 天全零值数据。

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator memberRepurchaseTranTimes
```

## 五、父级指标

父指标为会员复购率（`memberRepurchaseNoDifferenceRate`），复购会员消费频次作为复购深度的衡量指标。会员复购率当前也无有效数据。

## 六、过滤条件

用户报表不支持品类过滤。区域支持标准过滤（`--area-type` / `--area`）。

## 七、注意事项

1. 当前所有数据接口均返回空值或零值，报告生成时应省略此指标。
2. 复购会员消费频次是叶子指标，无下级子指标。
3. 该指标衡量复购会员的消费深度（平均消费次数），通常 valueUnit 为 2。
4. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户运营分析页面。