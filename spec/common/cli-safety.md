---
id: common-cli-safety
kind: spec
domain: common
title: 取数安全规则
tags:
  - safety
  - cli
  - report
match:
  keywords:
    - 禁止估算
    - 缺失值
    - 报告文件
    - template
---

# 取数安全规则

- 数值、同比、环比、排名、阈值必须来自 CLI 输出。
- 不得估算、补造或用示例数值替代缺失数据。
- 除非用户明确要求导出文件，否则不得写入报告文件。
- signal 前不得读取、打开、猜测或使用任何 template 文件。
