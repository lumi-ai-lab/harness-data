---
id: common-time-policy
kind: spec
domain: common
title: QDM 时间口径规则
tags:
  - time
  - cli
match:
  keywords:
    - 今天
    - 昨天
    - 最近
    - 本周
    - 上周
    - 本月
    - 上月
---

# QDM 时间口径规则

该文件定义用户自然语言时间表达如何映射到 CMR CLI 时间参数。hook 只提供当前日期和本规则；最终 CLI 时间参数由智能体根据用户问题推理。

## 当前日期

hook 会在上下文中提供 `current_date` 和 `timezone`。所有相对时间都基于这两个字段解释。

## 默认规则

- 用户未指定时间时，默认使用昨天，传 `--date YYYY-MM-DD`。
- 用户明确说今天、今日时，使用当前日期，传 `--date YYYY-MM-DD`。
- 用户明确说昨天、昨日时，使用当前日期前一日，传 `--date YYYY-MM-DD`。
- 用户明确给出具体日期时，使用该日期，传 `--date YYYY-MM-DD`。

## 周口径

- CMR CLI 的周参数使用业务周编码，格式为 `YYYY-NN`，例如 `2026-20`；不要使用 ISO 周字符串 `2026-W21`。
- 当前周按 QDM 业务周计算：优先以 `"$QDM_CMR_CLI" search weeks --page-size 5 --ai` 返回的第一条可用 `value` 为当前周。
- 用户说本周、这周、最近一周时，按 QDM 业务规则解释为当前所在周，传 `--week <当前周 value>`。
- 用户说上周时，使用 `search weeks` 返回列表中当前周之后的上一条可用 `value`。
- 不要用 `--date A..B` 或其他日期范围模拟周口径。

## 月口径

- 用户说本月、这个月时，解释为当前月份，传 `--month YYYY-MM`。
- 用户说上月时，解释为上一月份，传 `--month YYYY-MM`。
- 不要用日期范围模拟月口径。

## 财务报表特殊规则

`company` 报表只使用周或月口径。用户询问今天、昨天或具体日期的财务报表时，必须转换为该日期所在 QDM 业务周，传 `--week YYYY-NN`，并在最终报告中说明已按所在周统计。
