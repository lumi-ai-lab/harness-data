---
id: business-area-category-trend
kind: spec
domain: business
title: 经营分析区域品类趋势规则
tags:
  - report
  - area
  - category
  - trend
match:
  keywords:
    - 区域
    - 品类
    - 趋势
    - 华东
---

# 经营分析区域品类趋势规则

- 经营分析需要完成 overview、indicators、tree --values、area、category、trend 六个模块。
- 区域、品类和趋势结论必须来自对应 CLI 模块返回结果。
- 六个模块全部成功后，下一步必须立即执行 `python3 .claude/hooks/before-report-signal.py business-overview`。
