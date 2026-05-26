---
id: financial-index
kind: spec_index
domain: financial
title: 财务核心指标 Spec Index
tags:
  - index
  - financial-report
match:
  keywords:
    - 财务
    - 财务报表
    - 公司报表
    - EBITDA
context:
  default_files:
    - spec/financial/report-contract.md
children:
  - path: spec/financial/income-cost-profit.md
    keywords:
      - 营业收入
      - 毛利
      - 费用
      - EBITDA
  - path: spec/financial/s-ebitda-company-profit.md
    keywords:
      - EBITDA
      - 税息前利润
      - ebitdaCompanyProfit
  - path: spec/financial/s-company-business-income.md
    keywords:
      - 公司营业收入
      - 营业收入
      - companyBusinessIncome
  - path: spec/financial/s-finance-scm-income.md
    keywords:
      - 供应链收入
      - financeScmIncome
  - path: spec/financial/s-direct-store-income.md
    keywords:
      - 直营店收入
      - directStoreIncome
  - path: spec/financial/s-manage-franchise-fee.md
    keywords:
      - 品牌管理加盟费
      - 管理加盟费
      - manageFranchiseFee
  - path: spec/financial/s-other-business-profit.md
    keywords:
      - 其他业务收支净额
      - otherBusinessProfit
  - path: spec/financial/s-company-profit.md
    keywords:
      - 公司毛利额
      - companyProfit
  - path: spec/financial/s-finance-scm-profit.md
    keywords:
      - 供应链毛利额
      - financeScmProfit
  - path: spec/financial/s-direct-store-profit-amt.md
    keywords:
      - 直营店毛利额
      - directStoreProfitAmt
  - path: spec/financial/s-company-total-fee-rate.md
    keywords:
      - 费率
      - companyTotalFeeRate
  - path: spec/financial/s-company-total-fee.md
    keywords:
      - 总费用额
      - 费额
      - companyTotalFee
  - path: spec/financial/s-company-promotion-allowance-fee-rate.md
    keywords:
      - 宣传促销补贴费率
      - companyPromotionAllowanceFeeRate
  - path: spec/financial/s-company-promotion-allowance-fee.md
    keywords:
      - 宣传促销补贴费额
      - companyPromotionAllowanceFee
  - path: spec/financial/s-company-promotion-fee-rate.md
    keywords:
      - 宣传促销费率
      - companyPromotionFeeRate
  - path: spec/financial/s-company-promotion-fee.md
    keywords:
      - 宣传促销费额
      - companyPromotionFee
  - path: spec/financial/s-company-allowance-fee-rate.md
    keywords:
      - 补贴费用率
      - companyAllowanceFeeRate
  - path: spec/financial/s-company-allowance-fee.md
    keywords:
      - 补贴费用额
      - companyAllowanceFee
  - path: spec/financial/s-company-logistics-fee-rate.md
    keywords:
      - 物流费率
      - 运输费率
      - companyLogisticsFeeRate
  - path: spec/financial/s-company-logistics-fee.md
    keywords:
      - 物流费额
      - 运输费额
      - companyLogisticsFee
  - path: spec/financial/s-company-rent-fee-rate.md
    keywords:
      - 租金费率
      - companyRentFeeRate
  - path: spec/financial/s-company-rent-fee.md
    keywords:
      - 租金费额
      - companyRentFee
  - path: spec/financial/s-company-staff-fee-rate.md
    keywords:
      - 人员费用率
      - companyStaffFeeRate
  - path: spec/financial/s-company-staff-fee.md
    keywords:
      - 人员费用额
      - companyStaffFee
  - path: spec/financial/s-company-other-fee-rate.md
    keywords:
      - 其他费用率
      - companyOtherFeeRate
  - path: spec/financial/s-company-other-fee.md
    keywords:
      - 其他费用额
      - companyOtherFee
---

# 财务核心指标 Spec Index

财务核心指标默认读取报告合同；收入、毛利、费用、EBITDA 问题读取 income-cost-profit topic spec。
