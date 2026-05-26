---
id: business-s-scm-store-profit-notax-rate
kind: spec
domain: business
title: 供应链毛利率指标详情
tags:
  - report
  - metric
  - business-report
  - cust-penetration-rate
  - scmStoreProfitNotaxRate
match:
  keywords:
    - 供应链毛利率
    - scmStoreProfitNotaxRate
    - 供应链毛利率详情
    - 供应链毛利率指标详情
---

# 供应链毛利率指标详情

> 数据来源：`qdm-cmr-cli indicator detail --code scmStoreProfitNotaxRate --full`

## 基本信息

| 属性 | 值 |
| :--- | :--- |
| 指标中文名 | 供应链到店毛利率（不含税） |
| 指标英文 code | `scmStoreProfitNotaxRate` |
| 业务定义 | 仓库配送到门店的商品毛利额占出库到店收入的比例，不含税款 |
| 统计逻辑 | 供应链到店毛利额（不含税）/(出库到店金额（不含税）-abs(门店退货额（SAP）（不含税）)) |
| 业务环节 | 仓储环节 |

## 指标定位

- 供应链毛利率是客数渗透率维度下全链路盈利组的叶子指标。
- 所属维度：客数渗透率维度（用户渗透维度）。
- 报告章节：第三章 用户渗透维度深度拆解。
- 虽名为供应链毛利率，但在报告中归入用户渗透链路的全链路盈利部分。
- 固定拆解链路：`客数渗透率 -> 全链路毛利率 -> 供应链毛利率`。
- 上级指标：客数渗透率 `custPenetrationRate`。
- 父指标：全链路毛利率 `fullLinkStoreProfitNotaxRate`。
- 同组指标：门店毛利率 `profitRate`。

## 下钻子指标

无（叶子指标）。

## 边界与禁放规则

- 供应链毛利率是当前主指标，全链路毛利率和客数渗透率只能用于父级传导。
- 门店毛利率只能作为同组补充，不得替代主指标。
- 门店毛利额、供应链毛利额、销售额、客数、客单价及其下游指标不得作为本报告主指标行。
- 禁放：第四章（品效维度）、第五章（供应链维度）。
- 区域、品类、趋势证据可用于定位供应链毛利率结构分化和异常。
- 所有数值、同比、环比、排名、异常和根因必须来自 CLI 输出；CLI 未返回的指标行直接省略。