---
id: business-active-vender-num-vendor-accuracy-rate
kind: spec
domain: business
title: 准确率指标报告规则
tags:
  - metric
  - active-vender-num
  - vendorAccuracyRate
match:
  keywords:
    - 准确率
    - vendorAccuracyRate
    - 准确率情况
    - 准确率为什么下降
    - 准确率为什么提升
---

# 准确率指标报告规则

该文件用于经营分析下活跃供应商数树中的准确率专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `准确率` 或 `vendorAccuracyRate`。

固定拆解链路：

`活跃供应商数 -> 三率综合得分 -> 准确率`

## 指标位置

- 当前指标 code：`vendorAccuracyRate`
- 当前指标中文名：准确率
- 父指标：三率综合得分 `threeRateScore`
- 上级指标：活跃供应商数 `activeVenderNum`
- 同组指标：准点率 `vendorIntimeRate`、合格率 `vendorQualificationRate`

## 边界与禁放规则

- 准确率是本报告唯一主指标。
- 三率综合得分只用于父级传导，不能替代准确率主指标。
- 准点率、合格率只可作为同组对照，不能作为本报告主指标。
- 活跃供应商数、集采入库占比不得作为本报告主指标行；它们属于上级或同树其他专项。
- 品效、客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位准确率结构分化、履约准确性风险和数据异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
