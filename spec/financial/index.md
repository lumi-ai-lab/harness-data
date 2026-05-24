---
id: financial-index
kind: spec_index
domain: financial
title: 财务核心指标 Spec Index
tags:
  - index
  - financial-report
match:
  keywords:
    - 财务
    - 财务报表
    - 公司报表
    - EBITDA
context:
  default_files:
    - spec/financial/report-contract.md
children:
  - path: spec/financial/income-cost-profit.md
    keywords:
      - 营业收入
      - 毛利
      - 费用
      - EBITDA
---

# 财务核心指标 Spec Index

财务核心指标默认读取报告合同；收入、毛利、费用、EBITDA 问题读取 income-cost-profit topic spec。
