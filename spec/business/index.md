---
id: business-index
kind: spec_index
domain: business
title: 经营分析 Spec Index
tags:
  - index
  - business-report
match:
  keywords:
    - 经营
    - 经营分析
    - 业务表现
    - 销售
context:
  default_files:
    - spec/business/report-contract.md
children:
  - path: spec/business/core-indicators.md
    keywords:
      - 核心指标
      - 客数渗透率
      - 品效
      - 活跃供应商数
  - path: spec/business/area-category-trend.md
    keywords:
      - 区域
      - 品类
      - 趋势
---

# 经营分析 Spec Index

经营分析默认读取报告合同；涉及核心指标或区域、品类、趋势问题时读取对应 topic spec。
