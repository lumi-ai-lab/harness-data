---
id: member-s-cross-member-num
kind: spec
domain: member
title: 交叉会员数指标详情
tags:
  - report
  - metric
  - user-report
  - crossMemberNum
  - 交叉会员数
match:
  keywords:
    - 交叉会员数
    - 交叉会员数指标
    - 交叉会员数详情
    - crossMemberNum
---

## 基本信息

| 属性 | 值 |
|------|-----|
| 指标中文名 | 交叉会员数 |
| 指标英文code | crossMemberNum |
| 业务定义 | 同时在线上和线下都有过至少一次消费的会员数量 |
| 统计逻辑 | 同时在线上和线下都有过至少一次消费的会员id去重计数 |
| 业务环节 | 销售经营（会员价值与复购转化） |

## 指标定位

- **报表归属**: 用户报表（/report/3），alias: user
- **维度归属**: 会员价值与复购转化（第四章）
- **严禁放入**: 第三章（用户规模与分层结构）、第五章（用户触达与渠道效率）
- **指标层级**: 二级指标
- **父指标**: 门店会员销售占比（memberSaleAmtRate）
- **子指标**: 线下消费会员数（offlineMemberNum）、线上消费会员数（onlineMemberNum）
- **拆解链路**: 门店会员销售占比 -> 交叉会员数 -> 线下消费会员数 / 线上消费会员数

## 下钻子指标

| 子指标名称 | 子指标code | 说明 |
|-----------|-----------|------|
| 线下消费会员数 | offlineMemberNum | 通过线下渠道消费的会员数量 |
| 线上消费会员数 | onlineMemberNum | 通过线上渠道消费的会员数量 |

## 指标数值特征

- **valueUnit**: 1（整数）
- **阈值配置**: 无
- **mom/yoy unit**: 2（比率变化）
- **默认区域**: 全国（不含港澳），areaId=CN00
- **管理区域维度**: 粤西（CN01）、粤东（CN18）、华东（CN15）、运营直管（CN07）

## 边界与禁放规则

1. **禁止品类维度**: 用户报表不支持品类（category）过滤，不输出品类排名、品类拖累或品类贡献
2. **章节禁放**: 严禁放入第三章（用户规模与分层结构）和第五章（用户触达与渠道效率）
3. **区域默认**: 未指定区域时固定为全国（不含港澳）
4. **CLI命令前缀**: 必须使用 `qdm-cmr-cli report user`，不可使用 `qdm-cmr-cli report business`