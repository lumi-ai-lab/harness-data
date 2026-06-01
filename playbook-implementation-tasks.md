# 经营分析 Business Playbook 实施任务

## 背景

本任务文档以 `business-cmr-response.json` 中的指标清单为准，覆盖经营分析 business 版当前返回的全部指标。

当前全量指标数为 38 个。这里的 38 个指标包含已经完成 Playbook 的两个指标：

- 品效：`brandProductEffectiveness`
- 客数渗透率：`custPenetrationRate`

因此，后续新增待实施的 Playbook 为 36 个；但为了便于全量追踪，本文档仍按 38 个指标逐项建任务。

## 通用实施要求

- 每个指标建立一个独立 Playbook 文件，保存到 `wikis/playbooks/cmr/business/`。
- Playbook 命名遵循现有规则：`s-<指标 code 的 kebab-case>.md`。
- Playbook 内容遵循现有两个样例的规则：
  - 当前值使用新版 CMR CLI 的 `dupont` 命令。
  - 趋势使用 `trend` 命令。
  - 区域表现使用 `area` 命令。
  - 品类表现使用 legacy `report business category` 命令。
  - 默认查询口径为经营分析、昨天、全国、全品类。
  - 时间、区域、品类过滤规则沿用现有 Playbook。
- 如果指标没有对应 Spec 文件，仍然要实施 Playbook，但必须在任务和 Playbook 中特别标注：
  - `注意：该指标当前缺少对应 Spec，口径与禁用规则需后续与 Spec 对齐后复核。`

## 子任务清单

| 状态 | 指标 | code | Playbook 文件 | Spec 状态 | 任务 |
| --- | --- | --- | --- | --- | --- |
| 已完成 | 品效 | `brandProductEffectiveness` | `s-brand-product-effectiveness.md` | 已存在：`spec/cmr/business/s-brand-product-effectiveness.md` | 保持现有 Playbook，必要时只做索引对齐 |
| 已完成 | 客数渗透率 | `custPenetrationRate` | `s-cust-penetration-rate.md` | 已存在：`spec/cmr/business/s-cust-penetration-rate.md` | 保持现有 Playbook，必要时只做索引对齐 |
| 待实施 | 客数 | `custNum` | `s-cust-num.md` | 已存在：`spec/cmr/business/s-cust-num.md` | 新建单指标 Playbook |
| 待实施 | 19点前PI值 | `bf19CategoryStoreCustRate` | `s-bf19-category-store-cust-rate.md` | 已存在：`spec/cmr/business/s-bf19-category-store-cust-rate.md` | 新建单指标 Playbook |
| 待实施 | 销售额 | `saleAmt` | `s-sale-amt.md` | 已存在：`spec/cmr/business/s-sale-amt.md` | 新建单指标 Playbook |
| 待实施 | 出库折让率 | `scmPromotionTotalRate` | `s-scm-promotion-total-rate.md` | 已存在：`spec/cmr/business/s-scm-promotion-total-rate.md` | 新建单指标 Playbook |
| 待实施 | 客单价 | `perCustAmt` | `s-per-cust-amt.md` | 已存在：`spec/cmr/business/s-per-cust-amt.md` | 新建单指标 Playbook |
| 待实施 | 供应链毛利率 | `scmStoreProfitNotaxRate` | `s-scm-store-profit-notax-rate.md` | 已存在：`spec/cmr/business/s-scm-store-profit-notax-rate.md` | 新建单指标 Playbook |
| 待实施 | 19点前客数 | `bf19CustNum` | `s-bf19-cust-num.md` | 已存在：`spec/cmr/business/s-bf19-cust-num.md` | 新建单指标 Playbook |
| 待实施 | 商品订购渗透率 | `orderArticleRate` | `s-order-article-rate.md` | 已存在：`spec/cmr/business/s-order-article-rate.md` | 新建单指标 Playbook |
| 待实施 | 时段折扣率 | `hourDiscountRate` | `s-hour-discount-rate.md` | 已存在：`spec/cmr/business/s-hour-discount-rate.md` | 新建单指标 Playbook |
| 待实施 | 预期毛利率 | `preProfitRate` | `s-pre-profit-rate.md` | 已存在：`spec/cmr/business/s-pre-profit-rate.md` | 新建单指标 Playbook |
| 待实施 | 订购门店数 | `orderStores` | `s-order-stores.md` | 已存在：`spec/cmr/business/s-order-stores.md` | 新建单指标 Playbook |
| 待实施 | 19点前客单价 | `bf19PerCustAmt` | `s-bf19-per-cust-amt.md` | 已存在：`spec/cmr/business/s-bf19-per-cust-amt.md` | 新建单指标 Playbook |
| 待实施 | 供应链毛利额 | `scmStoreProfitAmtNotax` | `s-scm-store-profit-amt-notax.md` | 已存在：`spec/cmr/business/s-scm-store-profit-amt-notax.md` | 新建单指标 Playbook |
| 待实施 | 19点前件单价 | `bf19PerPieceAmt` | `s-bf19-per-piece-amt.md` | 已存在：`spec/cmr/business/s-bf19-per-piece-amt.md` | 新建单指标 Playbook |
| 待实施 | 19点前单均件数 | `bf19AvgPieceNum` | `s-bf19-avg-piece-num.md` | 已存在：`spec/cmr/business/s-bf19-avg-piece-num.md` | 新建单指标 Playbook |
| 待实施 | 全链路毛利额 | `fullLinkStoreProfitAmtNotax` | `s-full-link-store-profit-amt-notax.md` | 已存在：`spec/cmr/business/s-full-link-store-profit-amt-notax.md` | 新建单指标 Playbook |
| 待实施 | 可订门店数 | `storeCanOrders` | `s-store-can-orders.md` | 已存在：`spec/cmr/business/s-store-can-orders.md` | 新建单指标 Playbook |
| 待实施 | 促销折扣率 | `promotionDiscountRate` | `s-promotion-discount-rate.md` | 已存在：`spec/cmr/business/s-promotion-discount-rate.md` | 新建单指标 Playbook |
| 待实施 | 损耗率 | `lostRate` | `s-lost-rate.md` | 已存在：`spec/cmr/business/s-lost-rate.md` | 新建单指标 Playbook |
| 待实施 | 全链路毛利率 | `fullLinkStoreProfitNotaxRate` | `s-full-link-store-profit-notax-rate.md` | 已存在：`spec/cmr/business/s-full-link-store-profit-notax-rate.md` | 新建单指标 Playbook |
| 待实施 | 定价毛利率 | `prePriceProfitRate` | `s-pre-price-profit-rate.md` | 已存在：`spec/cmr/business/s-pre-price-profit-rate.md` | 新建单指标 Playbook |
| 待实施 | 订单满足率 | `satisfiedRate` | `s-satisfied-rate.md` | 已存在：`spec/cmr/business/s-satisfied-rate.md` | 新建单指标 Playbook |
| 待实施 | 19点前复购率 | `bf19MemberRepurchaseRate` | `s-bf19-member-repurchase-rate.md` | 已存在：`spec/cmr/business/s-bf19-member-repurchase-rate.md` | 新建单指标 Playbook |
| 待实施 | 门店毛利率 | `profitRate` | `s-profit-rate.md` | 已存在：`spec/cmr/business/s-profit-rate.md` | 新建单指标 Playbook |
| 待实施 | 门店毛利额 | `profitAmt` | `s-profit-amt.md` | 已存在：`spec/cmr/business/s-profit-amt.md` | 新建单指标 Playbook |
| 待实施 | 19点前销售占比 | `bf19SaleRate` | `s-bf19-sale-rate.md` | 已存在：`spec/cmr/business/s-bf19-sale-rate.md` | 新建单指标 Playbook |
| 待实施 | 19点前销售重量 | `bf19SaleWeight` | `s-bf19-sale-weight.md` | 已存在：`spec/cmr/business/s-bf19-sale-weight.md` | 新建单指标 Playbook |

## 缺少 Spec 的指标汇总

以下指标仍需实施 Playbook，但对应 Playbook 中必须加入 Spec 缺失提醒：

暂无。

## 验收标准

- 当前保留的 29 个指标全部在本文档中有任务行。
- 除已完成的 2 个 Playbook 外，其余 27 个指标均有待实施任务。
- 当前无缺少 Spec 的保留指标。
- 后续实施完成后，`wikis/playbooks/cmr/business/` 应覆盖 29 个单指标 Playbook。
