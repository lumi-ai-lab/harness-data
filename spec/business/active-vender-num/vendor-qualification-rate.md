---
id: business-active-vender-num-vendor-qualification-rate
kind: spec
domain: business
title: 合格率指标报告规则
tags:
  - metric
  - active-vender-num
  - vendorQualificationRate
match:
  keywords:
    - 合格率
    - vendorQualificationRate
    - 合格率情况
    - 合格率为什么下降
    - 合格率为什么提升
---

# 合格率指标报告规则

该文件用于经营分析下活跃供应商数树中的合格率专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `合格率` 或 `vendorQualificationRate`。

固定拆解链路：

`活跃供应商数 -> 三率综合得分 -> 合格率`

## 指标位置

- 当前指标 code：`vendorQualificationRate`
- 当前指标中文名：合格率
- 父指标：三率综合得分 `threeRateScore`
- 上级指标：活跃供应商数 `activeVenderNum`
- 同组指标：准确率 `vendorAccuracyRate`、准点率 `vendorIntimeRate`

## 边界与禁放规则

- 合格率是本报告唯一主指标。
- 三率综合得分只用于父级传导，不能替代合格率主指标。
- 准确率、准点率只可作为同组对照，不能作为本报告主指标。
- 活跃供应商数、集采入库占比不得作为本报告主指标行；它们属于上级或同树其他专项。
- 品效、客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位合格率结构分化、交付质量风险和数据异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
