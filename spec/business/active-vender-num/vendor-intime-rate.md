---
id: business-active-vender-num-vendor-intime-rate
kind: spec
domain: business
title: 准点率指标报告规则
tags:
  - metric
  - active-vender-num
  - vendorIntimeRate
match:
  keywords:
    - 准点率
    - vendorIntimeRate
    - 准点率情况
    - 准点率为什么下降
    - 准点率为什么提升
---

# 准点率指标报告规则

该文件用于经营分析下活跃供应商数树中的准点率专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `准点率` 或 `vendorIntimeRate`。

固定拆解链路：

`活跃供应商数 -> 三率综合得分 -> 准点率`

## 指标位置

- 当前指标 code：`vendorIntimeRate`
- 当前指标中文名：准点率
- 父指标：三率综合得分 `threeRateScore`
- 上级指标：活跃供应商数 `activeVenderNum`
- 同组指标：准确率 `vendorAccuracyRate`、合格率 `vendorQualificationRate`

## 边界与禁放规则

- 准点率是本报告唯一主指标。
- 三率综合得分只用于父级传导，不能替代准点率主指标。
- 准确率、合格率只可作为同组对照，不能作为本报告主指标。
- 活跃供应商数、集采入库占比不得作为本报告主指标行；它们属于上级或同树其他专项。
- 品效、客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位准点率结构分化、履约时效风险和数据异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
