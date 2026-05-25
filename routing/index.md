---
id: routing-index
kind: routing
domain: common
title: 路由导航
tags:
  - routing
  - index
match:
  keywords:
    - 路由
    - report
---

# QDM CLI 路由索引

Hook 只负责召回相关上下文文件，不预先决定单一 report 类型。Agent 读取本轮召回的 routing 文件后，再根据用户问题、spec 和 playbook 判断实际取数路径。

| report intent | playbook | routing file |
|---|---|---|
| 经营分析 | `playbooks/business/default-overview.md` | `routing/business-overview.md` |
| 经营分析-客数渗透率指标 | `playbooks/business/cust-penetration-rate/cust-penetration-rate.md` | `routing/business-cust-penetration-rate-cust-penetration-rate.md` |
| 经营分析-销售额指标 | `playbooks/business/cust-penetration-rate/sale-amt.md` | `routing/business-cust-penetration-rate-sale-amt.md` |
| 经营分析-19点前销售占比指标 | `playbooks/business/cust-penetration-rate/bf19-sale-rate.md` | `routing/business-cust-penetration-rate-bf19-sale-rate.md` |
| 经营分析-19点前销售重量指标 | `playbooks/business/cust-penetration-rate/bf19-sale-weight.md` | `routing/business-cust-penetration-rate-bf19-sale-weight.md` |
| 经营分析-订单满足率指标 | `playbooks/business/cust-penetration-rate/satisfied-rate.md` | `routing/business-cust-penetration-rate-satisfied-rate.md` |
| 经营分析-客数指标 | `playbooks/business/cust-penetration-rate/cust-num.md` | `routing/business-cust-penetration-rate-cust-num.md` |
| 经营分析-19点前客数指标 | `playbooks/business/cust-penetration-rate/bf19-cust-num.md` | `routing/business-cust-penetration-rate-bf19-cust-num.md` |
| 经营分析-19点前PI值指标 | `playbooks/business/cust-penetration-rate/bf19-category-store-cust-rate.md` | `routing/business-cust-penetration-rate-bf19-category-store-cust-rate.md` |
| 经营分析-19点前复购率指标 | `playbooks/business/cust-penetration-rate/bf19-member-repurchase-rate.md` | `routing/business-cust-penetration-rate-bf19-member-repurchase-rate.md` |
| 经营分析-客单价指标 | `playbooks/business/cust-penetration-rate/per-cust-amt.md` | `routing/business-cust-penetration-rate-per-cust-amt.md` |
| 经营分析-19点前客单价指标 | `playbooks/business/cust-penetration-rate/bf19-per-cust-amt.md` | `routing/business-cust-penetration-rate-bf19-per-cust-amt.md` |
| 经营分析-19点前单均件数指标 | `playbooks/business/cust-penetration-rate/bf19-avg-piece-num.md` | `routing/business-cust-penetration-rate-bf19-avg-piece-num.md` |
| 经营分析-19点前件单价指标 | `playbooks/business/cust-penetration-rate/bf19-per-piece-amt.md` | `routing/business-cust-penetration-rate-bf19-per-piece-amt.md` |
| 经营分析-全链路毛利率指标 | `playbooks/business/cust-penetration-rate/full-link-store-profit-notax-rate.md` | `routing/business-cust-penetration-rate-full-link-store-profit-notax-rate.md` |
| 经营分析-门店毛利率指标 | `playbooks/business/cust-penetration-rate/profit-rate.md` | `routing/business-cust-penetration-rate-profit-rate.md` |
| 经营分析-供应链毛利率指标 | `playbooks/business/cust-penetration-rate/scm-store-profit-notax-rate.md` | `routing/business-cust-penetration-rate-scm-store-profit-notax-rate.md` |
| 经营分析-全链路毛利额指标 | `playbooks/business/cust-penetration-rate/full-link-store-profit-amt-notax.md` | `routing/business-cust-penetration-rate-full-link-store-profit-amt-notax.md` |
| 经营分析-门店毛利额指标 | `playbooks/business/cust-penetration-rate/profit-amt.md` | `routing/business-cust-penetration-rate-profit-amt.md` |
| 经营分析-供应链毛利额指标 | `playbooks/business/cust-penetration-rate/scm-store-profit-amt-notax.md` | `routing/business-cust-penetration-rate-scm-store-profit-amt-notax.md` |
| 经营分析-品效下钻 | `playbooks/business/brand-product-effectiveness.md` | `routing/business-brand-product-effectiveness.md` |
| 经营分析-商品订购渗透率指标 | `playbooks/business/brand-product-effectiveness/order-article-rate.md` | `routing/business-brand-product-effectiveness-order-article-rate.md` |
| 经营分析-订购门店数指标 | `playbooks/business/brand-product-effectiveness/order-stores.md` | `routing/business-brand-product-effectiveness-order-stores.md` |
| 经营分析-可订门店数指标 | `playbooks/business/brand-product-effectiveness/store-can-orders.md` | `routing/business-brand-product-effectiveness-store-can-orders.md` |
| 经营分析-定价毛利率指标 | `playbooks/business/brand-product-effectiveness/pre-price-profit-rate.md` | `routing/business-brand-product-effectiveness-pre-price-profit-rate.md` |
| 经营分析-预期毛利率指标 | `playbooks/business/brand-product-effectiveness/pre-profit-rate.md` | `routing/business-brand-product-effectiveness-pre-profit-rate.md` |
| 经营分析-出库折让率指标 | `playbooks/business/brand-product-effectiveness/scm-promotion-total-rate.md` | `routing/business-brand-product-effectiveness-scm-promotion-total-rate.md` |
| 经营分析-时段折扣率指标 | `playbooks/business/brand-product-effectiveness/hour-discount-rate.md` | `routing/business-brand-product-effectiveness-hour-discount-rate.md` |
| 经营分析-促销折扣率指标 | `playbooks/business/brand-product-effectiveness/promotion-discount-rate.md` | `routing/business-brand-product-effectiveness-promotion-discount-rate.md` |
| 经营分析-售价价格指数指标 | `playbooks/business/brand-product-effectiveness/price-index.md` | `routing/business-brand-product-effectiveness-price-index.md` |
| 经营分析-采购价格指数指标 | `playbooks/business/brand-product-effectiveness/purchase-price-index.md` | `routing/business-brand-product-effectiveness-purchase-price-index.md` |
| 经营分析-损耗率指标 | `playbooks/business/brand-product-effectiveness/lost-rate.md` | `routing/business-brand-product-effectiveness-lost-rate.md` |
| 经营分析-活跃供应商数指标 | `playbooks/business/active-vender-num/active-vender-num.md` | `routing/business-active-vender-num-active-vender-num.md` |
| 经营分析-集采入库占比指标 | `playbooks/business/active-vender-num/central-instock-rate.md` | `routing/business-active-vender-num-central-instock-rate.md` |
| 经营分析-三率综合得分指标 | `playbooks/business/active-vender-num/three-rate-score.md` | `routing/business-active-vender-num-three-rate-score.md` |
| 经营分析-准确率指标 | `playbooks/business/active-vender-num/vendor-accuracy-rate.md` | `routing/business-active-vender-num-vendor-accuracy-rate.md` |
| 经营分析-准点率指标 | `playbooks/business/active-vender-num/vendor-intime-rate.md` | `routing/business-active-vender-num-vendor-intime-rate.md` |
| 经营分析-合格率指标 | `playbooks/business/active-vender-num/vendor-qualification-rate.md` | `routing/business-active-vender-num-vendor-qualification-rate.md` |
| 门店管理 | `playbooks/store/default-overview.md` | `routing/store-overview.md` |
| 用户运营 | `playbooks/member/default-overview.md` | `routing/member-overview.md` |
| 财务核心指标 | `playbooks/financial/default-overview.md` | `routing/financial-overview.md` |

公共约束：

- CLI 绝对路径集中配置在当前项目的 `config/qdm-cli-paths.env`。
- 必须使用 `$QDM_CMR_CLI`，不得使用本地静态示例值替代 CLI 返回值。
- 必需取数完成后，下一步必须立即执行 `bin/data-harness-cli inject-template`；template 注入前禁止总结、禁止整理报告素材、禁止生成中间分析、禁止输出阶段性结论。
- 最终报告必须等 `bin/data-harness-cli inject-template` 成功，并收到 selected playbook 绑定的 template 二阶段注入后再输出；template 注入后只注入 template 正文，不再注入 spec、routing 或 playbook；template 在 template 注入前不读取、不使用。
