---
id: common-area
kind: spec
domain: common
title: QDM 区域口径规则
tags:
  - area
  - cli
match:
  keywords:
    - 全国
    - 区域
    - 华东
    - 华南
    - 华北
    - 管理区域
---

# QDM 区域口径规则

- 未指定区域时，经营、门店、用户报告默认全国（不含港澳），CLI 参数使用 `--area-type 管理区域 --area CN00`。
- 财务 company 报表区域维度可选；用户未指定区域时不强制追加区域过滤，按 CLI 默认全国口径执行。
- 区域维度、区域名称和区域编码必须以 CMR CLI 返回或现有 routing/spec 明确规则为准，不得自行编造。
