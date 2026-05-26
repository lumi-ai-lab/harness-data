---
id: member-category-unsupported
kind: spec
domain: member
title: 用户报表品类不支持规则
tags:
  - report
  - category
  - unsupported
match:
  keywords:
    - 品类
    - 全品类
    - 分类
    - 类目
---

# 用户报表品类不支持规则

- 用户报表不支持 `--category-type` 和 `--category`，即使用户表达全品类也不得传入品类过滤。
- 品类口径写为用户报表默认全口径，不输出品类排名、品类拖累或品类贡献。
