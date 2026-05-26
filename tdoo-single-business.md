# 经营分析指标 Spec/Playbook/Template 补全任务

> 本文件记录经营分析（`/report/2`）下每个指标的 `s-` 前缀三件套（spec、playbook、template）的完成进度。
>
> 执行方式：对每个未完成的指标，使用 `/data-harness-single` Skill 生成对应文件。
>
> 指标来源：`qdm-cmr-cli report business tree`（2026-05-25 获取）。

## 进度总览

- 总指标数：**37**
- 已完成：**37**
- 待处理：**0**

---

## 一、客数渗透率维度（19 个指标）✅ 已全部完成

### 一级核心指标

- [x] **1. custPenetrationRate — 客数渗透率**
  - 文件：`s-cust-penetration-rate.md`
  - 父指标：无（一级核心）
  - 子指标：销售额、客数、客单价、全链路毛利率、全链路毛利额
  - 状态：✅ 已完成

### 规模类指标

- [x] **2. saleAmt — 销售额**
  - 文件：`s-sale-amt.md`
  - 状态：✅ 已完成

- [x] **3. bf19SaleRate — 19点前销售占比**
  - 文件：`s-bf19-sale-rate.md`
  - 状态：✅ 已完成

- [x] **4. bf19SaleWeight — 19点前销售重量**
  - 文件：`s-bf19-sale-weight.md`
  - 状态：✅ 已完成

- [x] **5. satisfiedRate — 订单满足率**
  - 文件：`s-satisfied-rate.md`
  - 状态：✅ 已完成

- [x] **6. custNum — 客数**
  - 文件：`s-cust-num.md`
  - 状态：✅ 已完成

- [x] **7. bf19CustNum — 19点前客数**
  - 文件：`s-bf19-cust-num.md`
  - 状态：✅ 已完成

- [x] **8. bf19CategoryStoreCustRate — 19点前PI值**
  - 文件：`s-bf19-category-store-cust-rate.md`
  - 状态：✅ 已完成

- [x] **9. bf19MemberRepurchaseRate — 19点前复购率**
  - 文件：`s-bf19-member-repurchase-rate.md`
  - 状态：✅ 已完成

- [x] **10. perCustAmt — 客单价**
  - 文件：`s-per-cust-amt.md`
  - 状态：✅ 已完成

- [x] **11. bf19PerCustAmt — 19点前客单价**
  - 文件：`s-bf19-per-cust-amt.md`
  - 状态：✅ 已完成

- [x] **12. bf19AvgPieceNum — 19点前单均件数**
  - 文件：`s-bf19-avg-piece-num.md`
  - 状态：✅ 已完成

- [x] **13. bf19PerPieceAmt — 19点前件单价**
  - 文件：`s-bf19-per-piece-amt.md`
  - 状态：✅ 已完成

### 全链路盈利指标

- [x] **14. fullLinkStoreProfitNotaxRate — 全链路毛利率**
  - 文件：`s-full-link-store-profit-notax-rate.md`
  - 状态：✅ 已完成

- [x] **15. profitRate — 门店毛利率**
  - 文件：`s-profit-rate.md`
  - 状态：✅ 已完成

- [x] **16. scmStoreProfitNotaxRate — 供应链毛利率**
  - 文件：`s-scm-store-profit-notax-rate.md`
  - 状态：✅ 已完成

- [x] **17. fullLinkStoreProfitAmtNotax — 全链路毛利额**
  - 文件：`s-full-link-store-profit-amt-notax.md`
  - 状态：✅ 已完成

- [x] **18. profitAmt — 门店毛利额**
  - 文件：`s-profit-amt.md`
  - 状态：✅ 已完成

- [x] **19. scmStoreProfitAmtNotax — 供应链毛利额**
  - 文件：`s-scm-store-profit-amt-notax.md`
  - 状态：✅ 已完成

---

## 二、品效维度（12 个指标）✅ 已全部完成

### 一级核心指标

- [x] **20. brandProductEffectiveness — 品效**
  - 文件：`s-brand-product-effectiveness.md`
  - 状态：✅ 已完成

### 商品订购渗透

- [x] **21. orderArticleRate — 商品订购渗透率**
  - 文件：`s-order-article-rate.md`
  - 状态：✅ 已完成

- [x] **22. orderStores — 订购门店数**
  - 文件：`s-order-stores.md`
  - 状态：✅ 已完成

- [x] **23. storeCanOrders — 可订门店数**
  - 文件：`s-store-can-orders.md`
  - 状态：✅ 已完成

### 定价毛利

- [x] **24. prePriceProfitRate — 定价毛利率**
  - 文件：`s-pre-price-profit-rate.md`
  - 状态：✅ 已完成

- [x] **25. preProfitRate — 预期毛利率**
  - 文件：`s-pre-profit-rate.md`
  - 状态：✅ 已完成

- [x] **26. scmPromotionTotalRate — 出库折让率**
  - 文件：`s-scm-promotion-total-rate.md`
  - 状态：✅ 已完成

- [x] **27. hourDiscountRate — 时段折扣率**
  - 文件：`s-hour-discount-rate.md`
  - 状态：✅ 已完成

- [x] **28. promotionDiscountRate — 促销折扣率**
  - 文件：`s-promotion-discount-rate.md`
  - 状态：✅ 已完成

- [x] **29. lostRate — 损耗率**
  - 文件：`s-lost-rate.md`
  - 状态：✅ 已完成

### 售价价格

- [x] **30. priceIndex — 售价价格指数(线上)**
  - 文件：`s-price-index.md`
  - 状态：✅ 已完成

- [x] **31. purchasePriceIndex — 采购价格指数**
  - 文件：`s-purchase-price-index.md`
  - 状态：✅ 已完成

---

## 三、供应链维度（6 个指标）✅ 已全部完成

### 一级核心指标

- [x] **32. activeVenderNum — 活跃供应商数**
  - 文件：`s-active-vender-num.md`
  - 状态：✅ 已完成

### 供应商合作与集采

- [x] **33. centralInstockRate — 集采入库占比**
  - 文件：`s-central-instock-rate.md`
  - 状态：✅ 已完成

- [x] **34. threeRateScore — 三率综合得分**
  - 文件：`s-three-rate-score.md`
  - 状态：✅ 已完成

### 履约质量三率

- [x] **35. vendorAccuracyRate — 准确率**
  - 文件：`s-vendor-accuracy-rate.md`
  - 状态：✅ 已完成

- [x] **36. vendorIntimeRate — 准点率**
  - 文件：`s-vendor-intime-rate.md`
  - 状态：✅ 已完成

- [x] **37. vendorQualificationRate — 合格率**
  - 文件：`s-vendor-qualification-rate.md`
  - 状态：✅ 已完成

---

## 附录：文件命名公式

```
英文 code 转 kebab-case（驼峰处插入 -，全小写），加 s- 前缀

示例：
  brandProductEffectiveness -> s-brand-product-effectiveness
  custPenetrationRate       -> s-cust-penetration-rate
  bf19SaleRate              -> s-bf19-sale-rate
  activeVenderNum           -> s-active-vender-num
```

## 附录：执行命令参考

对任意待处理指标，使用 Skill：

```
/data-harness-single
```

或在对话中直接说"帮我做 XX 指标"。