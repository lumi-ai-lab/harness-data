---
id: dim-area-index
kind: spec_index
domain: common
title: 维度区域 Spec Index
tags:
  - index
  - dim-area
  - area
match:
  keywords:
    - 全国
    - 区域
    - 华东
    - 华南
    - 华北
    - 管理区域
    - 大区
    - 区域维度
    - 区域编码
context:
  default_files:
    - spec/dim-area/manage-area.md
children:
  - path: spec/dim-area/manage-area.md
    keywords:
      - 管理区域
      - manageAreaId
      - CN00
  - path: spec/dim-area/sap-area.md
    keywords:
      - 大区
      - sapAreaId
      - 区域
---

# 维度区域 Spec Index

## 口径规则

- 未指定区域时，经营、门店、用户报告默认全国（不含港澳），CLI 参数使用 `--area-type 管理区域 --area CN00`。
- 财务 company 报表区域维度可选；用户未指定区域时不强制追加区域过滤，按 CLI 默认全国口径执行。
- 区域维度、区域名称和区域编码必须以 CMR CLI 返回或现有 routing/spec 明确规则为准，不得自行编造。

## 可用区域维度

数据来源：`qdm-cmr-cli search store-types --ai`（2026-05-25）

| 编码 | 中文名 |
|------|--------|
| manageAreaId | 管理区域 |
| sapAreaId | 大区 |
| groupManagerId | 督导 |
| storeId | 门店 |

## 维度编码映射

- 管理区域编码详见 `spec/dim-area/manage-area.md`
- 大区编码详见 `spec/dim-area/sap-area.md`