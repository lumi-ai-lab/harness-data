---
id: business-active-vender-num-central-instock-rate
kind: spec
domain: business
title: 集采入库占比指标报告规则
tags:
  - report
  - metric
  - business-report
  - active-vender-num
  - centralInstockRate
match:
  keywords:
    - 集采入库占比
    - centralInstockRate
    - 集采入库占比情况
    - 集采入库占比为什么下降
    - 集采入库占比为什么提升
---

# 集采入库占比指标报告规则

该文件用于经营分析下活跃供应商数树中的集采入库占比专项报告。取数固定使用 `qdm-cmr-cli report business`，指标固定为 `集采入库占比` 或 `centralInstockRate`。

固定拆解链路：

`活跃供应商数 -> 集采入库占比`

## 指标位置

- 当前指标 code：`centralInstockRate`
- 当前指标中文名：集采入库占比
- 父指标：活跃供应商数 `activeVenderNum`
- 子指标：无

## 边界与禁放规则

- 活跃供应商数只用于父级传导，不能替代集采入库占比主指标。
- 三率综合得分、准确率、准点率、合格率不得作为本报告主指标行；这些属于履约质量专项。
- 品效、客数渗透率、销售额、客数、客单价、全链路毛利率、全链路毛利额不得作为本报告主指标行。
- 区域、品类、趋势证据可用于定位集采入库占比结构分化和异常。
- 所有事实必须来自 CLI；CLI 未返回的指标行、区域、品类、趋势点直接省略。
