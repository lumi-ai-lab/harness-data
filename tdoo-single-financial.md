# 公司报表指标 Spec/Playbook/Template 补全任务

> 本文件记录公司报表（`/report/4`）下每个指标的 `s-` 前缀三件套（spec、playbook、template）的完成进度。
>
> 执行方式：对每个未完成的指标，使用 `/data-harness-single` Skill 生成对应文件。
>
> 指标来源：`qdm-cmr-cli report company tree`（2026-05-25 获取）。

## 与经营分析报表的关键差异

- **无品类表现图**：公司报表没有品类（category）维度，playbook 和 template 中不需要品类相关章节。
- **数据获取命令**：`qdm-cmr-cli report company` 替代 `qdm-cmr-cli report business`。
- **时间/区域过滤**：支持 `--date`/`--week`/`--month` 和 `--area-type`/`--area`。
- **费率指标有"额"子指标**：部分费率指标有对应的金额子指标（subIndicator），需作为独立指标处理。

## 进度总览

- 总指标数：**25**
- 已完成：**25**
- 待处理：**0**

---

## 一、EBITDA 维度（25 个指标）

### 一级核心指标

- [x] **1. ebitdaCompanyProfit — EBITDA**
  - 文件：`s-ebitda-company-profit.md`
  - 父指标：无（一级核心，showTable）
  - 子指标：公司营业收入、公司毛利额、费率
  - 状态：已完成

### 公司营业收入

- [x] **2. companyBusinessIncome — 公司营业收入**
  - 文件：`s-company-business-income.md`
  - 父指标：EBITDA（showTable）
  - 子指标：供应链收入、直营店收入、品牌管理&加盟费、其他业务收支净额
  - 状态：已完成

- [x] **3. financeScmIncome — 供应链收入**
  - 文件：`s-finance-scm-income.md`
  - 父指标：公司营业收入
  - 子指标：无（叶子指标）
  - 状态：已完成

- [x] **4. directStoreIncome — 直营店收入**
  - 文件：`s-direct-store-income.md`
  - 父指标：公司营业收入
  - 子指标：无（叶子指标）
  - 状态：已完成

- [x] **5. manageFranchiseFee — 品牌管理&加盟费**
  - 文件：`s-manage-franchise-fee.md`
  - 父指标：公司营业收入
  - 子指标：无（叶子指标）
  - 状态：已完成

- [x] **6. otherBusinessProfit — 其他业务收支净额**
  - 文件：`s-other-business-profit.md`
  - 父指标：公司营业收入
  - 子指标：无（叶子指标）
  - 状态：已完成

### 公司毛利额

- [x] **7. companyProfit — 公司毛利额**
  - 文件：`s-company-profit.md`
  - 父指标：EBITDA（showTable）
  - 子指标：供应链毛利额、直营店毛利额
  - 状态：已完成

- [x] **8. financeScmProfit — 供应链毛利额**
  - 文件：`s-finance-scm-profit.md`
  - 父指标：公司毛利额（lineType: dashed）
  - 子指标：无（叶子指标）
  - 状态：已完成

- [x] **9. directStoreProfitAmt — 直营店毛利额**
  - 文件：`s-direct-store-profit-amt.md`
  - 父指标：公司毛利额（lineType: dashed）
  - 子指标：无（叶子指标）
  - 状态：已完成

### 费率

- [x] **10. companyTotalFeeRate — 费率**
  - 文件：`s-company-total-fee-rate.md`
  - 父指标：EBITDA（showTable）
  - 子指标：宣传促销补贴费率、运输费率、租金费率、人员费用率、其他费用率
  - 金额子指标：`companyTotalFee`（总费用额）
  - 状态：已完成

- [x] **11. companyTotalFee — 总费用额**
  - 文件：`s-company-total-fee.md`
  - 父指标：费率（subIndicator）
  - 子指标：无（叶子指标，金额型）
  - 状态：已完成

- [x] **12. companyPromotionAllowanceFeeRate — 宣传促销补贴费率**
  - 文件：`s-company-promotion-allowance-fee-rate.md`
  - 父指标：费率
  - 子指标：宣传促销费率、补贴费用率
  - 金额子指标：`companyPromotionAllowanceFee`（宣传促销补贴费额）
  - 状态：已完成

- [x] **13. companyPromotionAllowanceFee — 宣传促销补贴费额**
  - 文件：`s-company-promotion-allowance-fee.md`
  - 父指标：宣传促销补贴费率（subIndicator）
  - 子指标：无（叶子指标，金额型）
  - 状态：已完成

- [x] **14. companyPromotionFeeRate — 宣传促销费率**
  - 文件：`s-company-promotion-fee-rate.md`
  - 父指标：宣传促销补贴费率
  - 子指标：无（叶子指标）
  - 金额子指标：`companyPromotionFee`（宣传促销费额）
  - 状态：已完成

- [x] **15. companyPromotionFee — 宣传促销费额**
  - 文件：`s-company-promotion-fee.md`
  - 父指标：宣传促销费率（subIndicator）
  - 子指标：无（叶子指标，金额型）
  - 状态：已完成

- [x] **16. companyAllowanceFeeRate — 补贴费用率**
  - 文件：`s-company-allowance-fee-rate.md`
  - 父指标：宣传促销补贴费率
  - 子指标：无（叶子指标）
  - 金额子指标：`companyAllowanceFee`（补贴费用额）
  - 状态：已完成

- [x] **17. companyAllowanceFee — 补贴费用额**
  - 文件：`s-company-allowance-fee.md`
  - 父指标：补贴费用率（subIndicator）
  - 子指标：无（叶子指标，金额型）
  - 状态：已完成

- [x] **18. companyLogisticsFeeRate — 运输费率**
  - 文件：`s-company-logistics-fee-rate.md`
  - 父指标：费率
  - 子指标：无（叶子指标）
  - 金额子指标：`companyLogisticsFee`（运输费额）
  - 状态：已完成

- [x] **19. companyLogisticsFee — 运输费额**
  - 文件：`s-company-logistics-fee.md`
  - 父指标：运输费率（subIndicator）
  - 子指标：无（叶子指标，金额型）
  - 状态：已完成

- [x] **20. companyRentFeeRate — 租金费率**
  - 文件：`s-company-rent-fee-rate.md`
  - 父指标：费率
  - 子指标：无（叶子指标）
  - 金额子指标：`companyRentFee`（租金费额）
  - 状态：已完成

- [x] **21. companyRentFee — 租金费额**
  - 文件：`s-company-rent-fee.md`
  - 父指标：租金费率（subIndicator）
  - 子指标：无（叶子指标，金额型）
  - 状态：已完成

- [x] **22. companyStaffFeeRate — 人员费用率**
  - 文件：`s-company-staff-fee-rate.md`
  - 父指标：费率
  - 子指标：无（叶子指标）
  - 金额子指标：`companyStaffFee`（人员费用额）
  - 状态：已完成

- [x] **23. companyStaffFee — 人员费用额**
  - 文件：`s-company-staff-fee.md`
  - 父指标：人员费用率（subIndicator）
  - 子指标：无（叶子指标，金额型）
  - 状态：已完成

- [x] **24. companyOtherFeeRate — 其他费用率**
  - 文件：`s-company-other-fee-rate.md`
  - 父指标：费率
  - 子指标：无（叶子指标）
  - 金额子指标：`companyOtherFee`（其他费用额）
  - 状态：已完成

- [x] **25. companyOtherFee — 其他费用额**
  - 文件：`s-company-other-fee.md`
  - 父指标：其他费用率（subIndicator）
  - 子指标：无（叶子指标，金额型）
  - 状态：已完成

---

## 附录：文件路径说明

```
spec/financial/s-<kebab-code>.md
playbook/financial/s-<kebab-code>.md
templates/financial/s-<kebab-code>.md
```

kebab-case 转换：驼峰处插入 `-`，全小写。
- `ebitdaCompanyProfit` -> `ebitda-company-profit`
- `companyPromotionAllowanceFeeRate` -> `company-promotion-allowance-fee-rate`

## 附录：Playbook 注意事项

- 无品类（category）图表 → playbook 跳过"五、获取品类表现数据"章节
- 费率指标有 subIndicator（金额子指标），spec 中需标注关联关系
- 金额型子指标（如 companyPromotionFee）本身可独立查询指标值
- 数据命令前缀为 `qdm-cmr-cli report company`

## 附录：执行命令参考

对任意待处理指标，使用 Skill：
```
/data-harness-single
```