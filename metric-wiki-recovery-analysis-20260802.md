# qdm-metric-cli Wiki 恢复旁路分析

- 分析基准：`HEAD`
- CLI：`/Users/jhyan/qdm/harness-data/wikis/qdm-metric-cli`
- CLI 版本：`0.1.0`
- Registry release：`registry-20260801-a443d4c9834a`
- Registry content hash：`sha256:a443d4c9834ada12705a259814710b5111f8feb4d3ace78daff0b88205dc1bce`

## 删除清单统计

- 删除 Metric 目录：183（549 个 spec/playbook/index 文件）
- 删除 Report 目录：7（每个 4 个文件）
- 删除 Dim 目录：4（每个 2 个文件）

### 删除 Report

- `主推时令大单品`
- `物流中心日报`
- `用户分析报告`
- `经营综合分析报告`
- `财务分析报告`
- `门店分析报告`
- `门店周边画像分析报告`

### 删除 Dim

- `全汇总维度编码`
- `行政区维度编码`
- `门店分层`
- `门店性质编码`

## Metric 删除与 Registry 对账

- 当前 Registry：430
- direct manifest：423
- composite manifest：5
- Wiki manifest union：428
- Registry 未进入 Wiki union：2
- Wiki union 不在 Registry：0
- manifest union 尚未渲染到当前 Metric 文档：0

### manifest 已纳入但当前文档目录尚未渲染

- 无

### 删除文档旧 code 仍存在于当前 Registry

- `customerStoreReturnAmtShop`
- `otherStoreReturnAmtShop`
- `outStockCopiesWms`
- `outStockPayAmtNotax`
- `qualityStoreReturnAmtShop`
- `quantityStoreReturnAmtShop`
- `storeReturnAmtShop`

### 删除文档同名但 code 已迁移

- `indicator_access_adjust_cost_notax` -> `accessAdjustCostNotax`（供应链考核调整成本（不含税））
- `indicator_access_adjust_income_notax` -> `accessAdjustIncomeNotax`（供应链考核调整收入（不含税））

## 删除 Metric 文档完整清单

| 目录 | 历史 code | 历史标题 | 当前判断 |
| --- | --- | --- | --- |
| `metrics/19点前PI值` | `bf19CategoryStoreCustRate` | 19点前PI值 | 当前 Registry 无 code/同名替代 |
| `metrics/8小时折算人数` | `laborHoursPer8` | 8小时折算人数 | 当前 Registry 无 code/同名替代 |
| `metrics/vip1活跃会员客单价` | `vip1ActiveMemberPerCustAmt` | vip1活跃会员客单价 | 当前 Registry 无 code/同名替代 |
| `metrics/vip1活跃会员数` | `vip1ActiveMemberNum` | vip1活跃会员数 | 当前 Registry 无 code/同名替代 |
| `metrics/vip1活跃会员消费频次` | `vip1ActiveMemberTranTimes` | vip1活跃会员消费频次 | 当前 Registry 无 code/同名替代 |
| `metrics/vip2活跃会员客单价` | `vip2ActiveMemberPerCustAmt` | vip2活跃会员客单价 | 当前 Registry 无 code/同名替代 |
| `metrics/vip2活跃会员数` | `vip2ActiveMemberNum` | vip2活跃会员数 | 当前 Registry 无 code/同名替代 |
| `metrics/vip2活跃会员消费频次` | `vip2ActiveMemberTranTimes` | vip2活跃会员消费频次 | 当前 Registry 无 code/同名替代 |
| `metrics/vip3活跃会员客单价` | `vip3ActiveMemberPerCustAmt` | vip3活跃会员客单价 | 当前 Registry 无 code/同名替代 |
| `metrics/vip3活跃会员数` | `vip3ActiveMemberNum` | vip3活跃会员数 | 当前 Registry 无 code/同名替代 |
| `metrics/vip3活跃会员消费频次` | `vip3ActiveMemberTranTimes` | vip3活跃会员消费频次 | 当前 Registry 无 code/同名替代 |
| `metrics/交叉会员数` | `spec_cmr_member_s_cross_member_num` | 交叉会员数 | 当前 Registry 无 code/同名替代 |
| `metrics/人员费用率` | `companyStaffFeeRate` | 人员费用率 | 当前 Registry 无 code/同名替代 |
| `metrics/人员费用额` | `companyStaffFee` | 人员费用额 | 当前 Registry 无 code/同名替代 |
| `metrics/人效` | `laborEffective` | 人效 | 当前 Registry 无 code/同名替代 |
| `metrics/仓端温控合格率` | `logistics_metric_083` | 仓端温控合格率 | 当前 Registry 无 code/同名替代 |
| `metrics/份数坪效` | `logistics_metric_069` | 份数坪效 | 当前 Registry 无 code/同名替代 |
| `metrics/休眠期会员数` | `dormantMemberNum` | 休眠期会员数 | 当前 Registry 无 code/同名替代 |
| `metrics/会员数` | `memberNum` | 会员数 | 当前 Registry 无 code/同名替代 |
| `metrics/供应商准时到达次数` | `ontimeNumWms` | 供应商准时到达次数 | 当前 Registry 无 code/同名替代 |
| `metrics/供应商准点率` | `ontimeNumWmsPerAllNumWms` | 供应商准点率 | 当前 Registry 无 code/同名替代 |
| `metrics/供应商总次数` | `allNumWms` | 供应商总次数 | 当前 Registry 无 code/同名替代 |
| `metrics/供应链收入(财务)` | `financeScmIncome` | 供应链收入(财务) | 当前 Registry 无 code/同名替代 |
| `metrics/供应链毛利额(财务)` | `financeScmProfit` | 供应链毛利额(财务) | 当前 Registry 无 code/同名替代 |
| `metrics/供应链考核调整成本（不含税）` | `indicator_access_adjust_cost_notax` | 供应链考核调整成本（不含税） | 同名迁移到：`accessAdjustCostNotax` |
| `metrics/供应链考核调整收入（不含税）` | `indicator_access_adjust_income_notax` | 供应链考核调整收入（不含税） | 同名迁移到：`accessAdjustIncomeNotax` |
| `metrics/停业超30天门店数` | `stop30dayStores` | 停业超30天门店数 | 当前 Registry 无 code/同名替代 |
| `metrics/公司毛利额` | `companyProfit` | 公司毛利额 | 当前 Registry 无 code/同名替代 |
| `metrics/公司营业收入` | `companyBusinessIncome` | 公司营业收入 | 当前 Registry 无 code/同名替代 |
| `metrics/其他业务收支净额` | `otherBusinessProfit` | 其他业务收支净额 | 当前 Registry 无 code/同名替代 |
| `metrics/其他出库到店重量（WMS换算后）` | `otherOutStockWeightWms` | 其他出库到店重量（WMS换算后） | 当前 Registry 无 code/同名替代 |
| `metrics/其他类门店退货额` | `otherStoreReturnAmtShop` | 其他类门店退货额 | 当前 Registry 仍存在：`otherStoreReturnAmtShop` |
| `metrics/其他费用率` | `companyOtherFeeRate` | 其他费用率 | 当前 Registry 无 code/同名替代 |
| `metrics/其他费用额` | `companyOtherFee` | 其他费用额 | 当前 Registry 无 code/同名替代 |
| `metrics/其他退货率（金额）` | `otherStoreReturnAmtShopPerOutStockPayAmt` | 其他退货率（金额） | 当前 Registry 无 code/同名替代 |
| `metrics/出库到店份数（WMS转换后）` | `outStockCopiesWms` | 出库到店份数（WMS转换后） | 当前 Registry 仍存在：`outStockCopiesWms` |
| `metrics/出库到店重量` | `outStockWeightWmsTon` | 出库到店重量 | 当前 Registry 无 code/同名替代 |
| `metrics/出库到店金额` | `outStockPayAmtNotax` | 出库到店金额 | 当前 Registry 仍存在：`outStockPayAmtNotax` |
| `metrics/出库店数` | `countStore` | 出库店数 | 当前 Registry 无 code/同名替代 |
| `metrics/分拣多货少货数量率(0容忍)` | `absPickShortQtyPlusPickMoreQtyPerStoreOrderWeightNotkg` | 分拣多货少货数量率(0容忍) | 当前 Registry 无 code/同名替代 |
| `metrics/分拣多货少货重量率(0容忍)` | `absPickShortWeightPlusPickMoreWeightPerStoreOrderWeightKg` | 分拣多货少货重量率(0容忍) | 当前 Registry 无 code/同名替代 |
| `metrics/分拣多货少货金额(0容忍)` | `absPickShortWeightAmtPlusAbsPickShortQtyAmtPlusPickMoreWeightAmtPlusPickMoreQtyAmt` | 分拣多货少货金额(0容忍) | 当前 Registry 无 code/同名替代 |
| `metrics/分拣多货数量金额（非kg订kg结）` | `pickMoreQtyAmt` | 分拣多货数量金额（非kg订kg结） | 当前 Registry 无 code/同名替代 |
| `metrics/分拣多货数量（非kg订kg结）` | `pickMoreQty` | 分拣多货数量（非kg订kg结） | 当前 Registry 无 code/同名替代 |
| `metrics/分拣多货重量金额（kg订kg结）` | `pickMoreWeightAmt` | 分拣多货重量金额（kg订kg结） | 当前 Registry 无 code/同名替代 |
| `metrics/分拣多货重量（kg订kg结）` | `pickMoreWeight` | 分拣多货重量（kg订kg结） | 当前 Registry 无 code/同名替代 |
| `metrics/分拣少货数量金额（非kg订kg结）` | `pickShortQtyAmt` | 分拣少货数量金额（非kg订kg结） | 当前 Registry 无 code/同名替代 |
| `metrics/分拣少货数量（非kg订kg结）` | `pickShortQty` | 分拣少货数量（非kg订kg结） | 当前 Registry 无 code/同名替代 |
| `metrics/分拣少货重量金额（kg订kg结）` | `pickShortWeightAmt` | 分拣少货重量金额（kg订kg结） | 当前 Registry 无 code/同名替代 |
| `metrics/分拣少货重量（kg订kg结）` | `pickShortWeight` | 分拣少货重量（kg订kg结） | 当前 Registry 无 code/同名替代 |
| `metrics/到店晚点门店次数` | `lateStoreTimes` | 到店晚点门店次数 | 当前 Registry 无 code/同名替代 |
| `metrics/到店迟到次数（迟到补贴）` | `lateArrivalCount` | 到店迟到次数（迟到补贴） | 当前 Registry 无 code/同名替代 |
| `metrics/单一SKU金额大于1000元次数(数量类)` | `skuOver1000Cnt` | 单一SKU金额大于1000元次数(数量类) | 当前 Registry 无 code/同名替代 |
| `metrics/单公斤货值` | `outStockPayAmtNotaxPerWeightWms` | 单公斤货值 | 当前 Registry 无 code/同名替代 |
| `metrics/可触达用户数` | `reachMemberNum` | 可触达用户数 | 当前 Registry 无 code/同名替代 |
| `metrics/可订门店数` | `storeCanOrders` | 可订门店数 | 当前 Registry 无 code/同名替代 |
| `metrics/合计-WMS货物总重量` | `wmsLoadWeightTon` | 合计-WMS货物总重量 | 当前 Registry 无 code/同名替代 |
| `metrics/合计-店均运费(综合+猪肉)` | `scheduleTotalCostPerStoreNum` | 合计-店均运费(综合+猪肉) | 当前 Registry 无 code/同名替代 |
| `metrics/合计-车均运费` | `scheduleTotalCostPerDonoCnt` | 合计-车均运费 | 当前 Registry 无 code/同名替代 |
| `metrics/合计-车次数` | `donoCnt` | 合计-车次数 | 当前 Registry 无 code/同名替代 |
| `metrics/品效` | `brandProductEffectiveness` | 品效 | 当前 Registry 无 code/同名替代 |
| `metrics/品类重量占比-水产` | `seafoodOutStockWeightWmsPerOutStockWeightWms` | 品类重量占比-水产 | 当前 Registry 无 code/同名替代 |
| `metrics/品类重量占比-水果` | `fruitOutStockWeightWmsPerOutStockWeightWms` | 品类重量占比-水果 | 当前 Registry 无 code/同名替代 |
| `metrics/品类重量占比-猪肉` | `porkOutStockWeightWmsPerOutStockWeightWms` | 品类重量占比-猪肉 | 当前 Registry 无 code/同名替代 |
| `metrics/品类重量占比-电商` | `onlineOutStockWeightWmsPerOutStockWeightWms` | 品类重量占比-电商 | 当前 Registry 无 code/同名替代 |
| `metrics/品类重量占比-综合` | `otherOutStockWeightWmsPerOutStockWeightWms` | 品类重量占比-综合 | 当前 Registry 无 code/同名替代 |
| `metrics/品类重量占比-蔬菜` | `vegetableOutStockWeightWmsPerOutStockWeightWms` | 品类重量占比-蔬菜 | 当前 Registry 无 code/同名替代 |
| `metrics/商品订购渗透率` | `orderArticleRate` | 商品订购渗透率 | 当前 Registry 无 code/同名替代 |
| `metrics/坪效` | `areaEffective` | 坪效 | 当前 Registry 无 code/同名替代 |
| `metrics/客数渗透率` | `custPenetrationRate` | 客数渗透率 | 当前 Registry 无 code/同名替代 |
| `metrics/客诉次数` | `logistics_metric_033` | 客诉次数 | 当前 Registry 无 code/同名替代 |
| `metrics/宣传促销补贴费率` | `companyPromotionAllowanceFeeRate` | 宣传促销补贴费率 | 当前 Registry 无 code/同名替代 |
| `metrics/宣传促销补贴费额` | `companyPromotionAllowanceFee` | 宣传促销补贴费额 | 当前 Registry 无 code/同名替代 |
| `metrics/宣传促销费率` | `companyPromotionFeeRate` | 宣传促销费率 | 当前 Registry 无 code/同名替代 |
| `metrics/宣传促销费额` | `companyPromotionFee` | 宣传促销费额 | 当前 Registry 无 code/同名替代 |
| `metrics/店均重量` | `outStockWeightWmsPerCountStore` | 店均重量 | 当前 Registry 无 code/同名替代 |
| `metrics/店均面积（生产面积）` | `logistics_metric_068` | 店均面积（生产面积） | 当前 Registry 无 code/同名替代 |
| `metrics/总工时` | `laborHours` | 总工时 | 当前 Registry 无 code/同名替代 |
| `metrics/总退货率（金额）` | `storeReturnAmtShopPerOutStockPayAmt` | 总退货率（金额） | 当前 Registry 无 code/同名替代 |
| `metrics/总配送门店次数` | `deliveryStoreTimes` | 总配送门店次数 | 当前 Registry 无 code/同名替代 |
| `metrics/数量类门店退货额` | `quantityStoreReturnAmtShop` | 数量类门店退货额 | 当前 Registry 仍存在：`quantityStoreReturnAmtShop` |
| `metrics/数量退货率（金额）` | `quantityStoreReturnAmtShopPerOutStockPayAmt` | 数量退货率（金额） | 当前 Registry 无 code/同名替代 |
| `metrics/新客首单客单价` | `firstTranMemberPerCustAmt` | 新客首单客单价 | 当前 Registry 无 code/同名替代 |
| `metrics/新消费用户数` | `firstTranMemberNum` | 新消费用户数 | 当前 Registry 无 code/同名替代 |
| `metrics/普通活跃会员客单价` | `regularActiveMemberPerCustAmt` | 普通活跃会员客单价 | 当前 Registry 无 code/同名替代 |
| `metrics/普通活跃会员数` | `regularActiveMemberNum` | 普通活跃会员数 | 当前 Registry 无 code/同名替代 |
| `metrics/普通活跃会员消费频次` | `regularActiveMemberTranTimes` | 普通活跃会员消费频次 | 当前 Registry 无 code/同名替代 |
| `metrics/水产出库到店重量（WMS换算后）` | `seafoodOutStockWeightWms` | 水产出库到店重量（WMS换算后） | 当前 Registry 无 code/同名替代 |
| `metrics/水果出库到店重量（WMS换算后）` | `fruitOutStockWeightWms` | 水果出库到店重量（WMS换算后） | 当前 Registry 无 code/同名替代 |
| `metrics/活跃用户数` | `activeMemberNum` | 活跃用户数 | 当前 Registry 无 code/同名替代 |
| `metrics/流失期用户数` | `churnedMemberNum` | 流失期用户数 | 当前 Registry 无 code/同名替代 |
| `metrics/温控不合格线路数` | `tempFailCnt` | 温控不合格线路数 | 当前 Registry 无 code/同名替代 |
| `metrics/温控合格线路数` | `tempPassCnt` | 温控合格线路数 | 当前 Registry 无 code/同名替代 |
| `metrics/温控线路总数` | `tempLineCnt` | 温控线路总数 | 当前 Registry 无 code/同名替代 |
| `metrics/点位数` | `storeNum` | 点位数 | 当前 Registry 无 code/同名替代 |
| `metrics/物流费率` | `companyLogisticsFeeRate` | 物流费率 | 当前 Registry 无 code/同名替代 |
| `metrics/物流费额` | `companyLogisticsFee` | 物流费额 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓-实际配送门店数` | `porkRealShopNum` | 猪肉仓-实际配送门店数 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓-点位数` | `porkStoreNum` | 猪肉仓-点位数 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓-线路总费用（元）` | `porkScheduleTotalCost` | 猪肉仓-线路总费用（元） | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓-重量里程（kg·km）` | `porkWeightMileage` | 猪肉仓-重量里程（kg·km） | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓出库到店金额` | `porkOutStockPayAmtNotax` | 猪肉仓出库到店金额 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓车效-吨公里运费` | `porkScheduleTotalCostPerWeightMileage` | 猪肉仓车效-吨公里运费 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓车效-店均运费` | `porkScheduleTotalCostPerStoreNum` | 猪肉仓车效-店均运费 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓车效-猪肉仓-装载重量` | `porkWmsLoadWeightTon` | 猪肉仓车效-猪肉仓-装载重量 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓车效-车均装载头数` | `porkOutCountPerDonoCnt` | 猪肉仓车效-车均装载头数 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓车效-车均装载店数` | `porkRealShopNumPerDonoCnt` | 猪肉仓车效-车均装载店数 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓车效-车均运费` | `porkScheduleTotalCostPerDonoCnt` | 猪肉仓车效-车均运费 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉仓车效-车次数` | `porkDonoCnt` | 猪肉仓车效-车次数 | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉出库到店重量（WMS换算后）` | `porkOutStockWeightWms` | 猪肉出库到店重量（WMS换算后） | 当前 Registry 无 code/同名替代 |
| `metrics/猪肉店均重量` | `porkOutStockWeightWmsPerCountStore` | 猪肉店均重量 | 当前 Registry 无 code/同名替代 |
| `metrics/电商SKU数` | `onlineSkuCnt` | 电商SKU数 | 当前 Registry 无 code/同名替代 |
| `metrics/电商出库到店重量（WMS换算后）` | `onlineOutStockWeightWms` | 电商出库到店重量（WMS换算后） | 当前 Registry 无 code/同名替代 |
| `metrics/盈亏平衡点` | `breakEvenPoint` | 盈亏平衡点 | 当前 Registry 无 code/同名替代 |
| `metrics/直接工时` | `directLaborHours` | 直接工时 | 当前 Registry 无 code/同名替代 |
| `metrics/直接工时占比` | `directLaborHoursPerLaborHours` | 直接工时占比 | 当前 Registry 无 code/同名替代 |
| `metrics/直营店收入` | `directStoreIncome` | 直营店收入 | 当前 Registry 无 code/同名替代 |
| `metrics/直营店毛利额` | `directStoreProfitAmt` | 直营店毛利额 | 当前 Registry 无 code/同名替代 |
| `metrics/社群用户数` | `communityUserNum` | 社群用户数 | 当前 Registry 无 code/同名替代 |
| `metrics/租金费率` | `companyRentFeeRate` | 租金费率 | 当前 Registry 无 code/同名替代 |
| `metrics/租金费额` | `companyRentFee` | 租金费额 | 当前 Registry 无 code/同名替代 |
| `metrics/税息前利润` | `ebitdaCompanyProfit` | 税息前利润 | 当前 Registry 无 code/同名替代 |
| `metrics/管理&加盟费` | `manageFranchiseFee` | 管理&加盟费 | 当前 Registry 无 code/同名替代 |
| `metrics/线上消费会员数` | `spec_cmr_member_s_online_member_num` | 线上消费会员数 | 当前 Registry 无 code/同名替代 |
| `metrics/线下消费会员数` | `spec_cmr_member_s_offline_member_num` | 线下消费会员数 | 当前 Registry 无 code/同名替代 |
| `metrics/线路总费用（元）` | `scheduleTotalCost` | 线路总费用（元） | 当前 Registry 无 code/同名替代 |
| `metrics/综合SKU数` | `offlineSkuCnt` | 综合SKU数 | 当前 Registry 无 code/同名替代 |
| `metrics/综合人效-份数` | `outStockCopiesWmsPerLaborHours` | 综合人效-份数 | 当前 Registry 无 code/同名替代 |
| `metrics/综合人效-重量` | `outStockWeightWmsPerLaborHours` | 综合人效-重量 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓出库到店金额` | `outStockPayAmtNotaxMinusPorkOutStockPayAmtNotax` | 综合仓出库到店金额 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-吨公里运费` | `nonporkScheduleTotalCostPerWeightMileage` | 综合仓车效-吨公里运费 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-吨公里运费-4.2米车型` | `nonporkSmallVehicleScheduleTotalCostPerWeightMileage` | 综合仓车效-吨公里运费-4.2米车型 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-吨公里运费-大车型` | `nonporkLargeVehicleScheduleTotalCostPerWeightMileage` | 综合仓车效-吨公里运费-大车型 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-店均运费` | `nonporkScheduleTotalCostPerStoreNum` | 综合仓车效-店均运费 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-店均运费-4.2米车型` | `nonporkSmallVehicleScheduleTotalCostPerStoreNum` | 综合仓车效-店均运费-4.2米车型 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-店均运费-大车型` | `nonporkLargeVehicleScheduleTotalCostPerStoreNum` | 综合仓车效-店均运费-大车型 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-车均装载店数-4米2` | `nonporkSmallVehicleShopNumPerDonoCnt` | 综合仓车效-车均装载店数-4米2 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-车均装载店数-大车型` | `nonporkLargeVehicleShopNumPerDonoCnt` | 综合仓车效-车均装载店数-大车型 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-车均装载重量-4米2` | `nonporkSmallVehicleWmsLoadWeightPerDonoCnt` | 综合仓车效-车均装载重量-4米2 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-车均装载重量-大车型` | `nonporkLargeVehicleWmsLoadWeightPerDonoCnt` | 综合仓车效-车均装载重量-大车型 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-车均运费` | `nonporkScheduleTotalCostPerDonoCnt` | 综合仓车效-车均运费 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-车均运费-4.2米车型` | `nonporkSmallVehicleScheduleTotalCostPerDonoCnt` | 综合仓车效-车均运费-4.2米车型 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-车均运费-大车型` | `nonporkLargeVehicleScheduleTotalCostPerDonoCnt` | 综合仓车效-车均运费-大车型 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-车次数` | `nonporkDonoCnt` | 综合仓车效-车次数 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-车次数-4.2米车型` | `nonporkSmallVehicleDonoCnt` | 综合仓车效-车次数-4.2米车型 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-车次数-大车型` | `nonporkLargeVehicleDonoCnt` | 综合仓车效-车次数-大车型 | 当前 Registry 无 code/同名替代 |
| `metrics/综合仓车效-非猪肉仓-装载重量` | `nonporkWmsLoadWeightTon` | 综合仓车效-非猪肉仓-装载重量 | 当前 Registry 无 code/同名替代 |
| `metrics/综合店均重量` | `outStockWeightWmsMinusPorkOutStockWeightWmsPerCountStore` | 综合店均重量 | 当前 Registry 无 code/同名替代 |
| `metrics/菜吧柜子数量` | `indicator_cabinet_num` | 菜吧柜子数量 | 当前 Registry 无 code/同名替代 |
| `metrics/蔬菜出库到店重量（WMS换算后）` | `vegetableOutStockWeightWms` | 蔬菜出库到店重量（WMS换算后） | 当前 Registry 无 code/同名替代 |
| `metrics/补贴费用率` | `companyAllowanceFeeRate` | 补贴费用率 | 当前 Registry 无 code/同名替代 |
| `metrics/补贴费用额` | `companyAllowanceFee` | 补贴费用额 | 当前 Registry 无 code/同名替代 |
| `metrics/质量类门店退货额` | `qualityStoreReturnAmtShop` | 质量类门店退货额 | 当前 Registry 仍存在：`qualityStoreReturnAmtShop` |
| `metrics/质量退货率（金额）` | `qualityStoreReturnAmtShopPerOutStockPayAmt` | 质量退货率（金额） | 当前 Registry 无 code/同名替代 |
| `metrics/费率` | `companyTotalFeeRate` | 费率 | 当前 Registry 无 code/同名替代 |
| `metrics/费额` | `companyTotalFee` | 费额 | 当前 Registry 无 code/同名替代 |
| `metrics/边猪出库头数` | `porkOutCount` | 边猪出库头数 | 当前 Registry 无 code/同名替代 |
| `metrics/运输准点率（到店晚点）` | `deliveryStoreTimesMinusLateStoreTimesPerDeliveryStoreTimes` | 运输准点率（到店晚点） | 当前 Registry 无 code/同名替代 |
| `metrics/配端温控合格率` | `tempPassCntPerLineCnt` | 配端温控合格率 | 当前 Registry 无 code/同名替代 |
| `metrics/销售渠道坑产` | `indicator_sale_mode_pit_production` | 销售渠道坑产 | 当前 Registry 无 code/同名替代 |
| `metrics/门店人数（indicators）` | `storeNumIndicators` | 门店人数（indicators） | 当前 Registry 无 code/同名替代 |
| `metrics/门店会员销售占比` | `spec_cmr_member_s_member_sale_amt_rate` | 门店会员销售占比 | 当前 Registry 无 code/同名替代 |
| `metrics/门店净利润` | `netProfit` | 门店净利润 | 当前 Registry 无 code/同名替代 |
| `metrics/门店覆盖人口数` | `usualResidents` | 门店覆盖人口数 | 当前 Registry 无 code/同名替代 |
| `metrics/门店订购数量（非kg订kg结）` | `storeOrderWeightNotkg` | 门店订购数量（非kg订kg结） | 当前 Registry 无 code/同名替代 |
| `metrics/门店订购重量（kg订kg结）` | `storeOrderWeightKg` | 门店订购重量（kg订kg结） | 当前 Registry 无 code/同名替代 |
| `metrics/门店退货额` | `storeReturnAmtShop` | 门店退货额 | 当前 Registry 仍存在：`storeReturnAmtShop` |
| `metrics/门店面积` | `storeArea` | 门店面积 | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-大车型-实际配送门店数` | `nonporkLargeVehicleShopNum` | 非猪肉仓-大车型-实际配送门店数 | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-大车型-点位数` | `nonporkLargeVehicleStoreNum` | 非猪肉仓-大车型-点位数 | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-大车型-线路总费用（元）` | `nonporkLargeVehicleScheduleTotalCost` | 非猪肉仓-大车型-线路总费用（元） | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-大车型-装载重量（kg）` | `nonporkLargeVehicleWmsLoadWeight` | 非猪肉仓-大车型-装载重量（kg） | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-大车型-重量里程（kg·km）` | `nonporkLargeVehicleWeightMileage` | 非猪肉仓-大车型-重量里程（kg·km） | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-小车型-实际配送门店数` | `nonporkSmallVehicleShopNum` | 非猪肉仓-小车型-实际配送门店数 | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-小车型-点位数` | `nonporkSmallVehicleStoreNum` | 非猪肉仓-小车型-点位数 | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-小车型-线路总费用（元）` | `nonporkSmallVehicleScheduleTotalCost` | 非猪肉仓-小车型-线路总费用（元） | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-小车型-装载重量（kg）` | `nonporkSmallVehicleWmsLoadWeight` | 非猪肉仓-小车型-装载重量（kg） | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-小车型-重量里程（kg·km）` | `nonporkSmallVehicleWeightMileage` | 非猪肉仓-小车型-重量里程（kg·km） | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-点位数` | `nonporkStoreNum` | 非猪肉仓-点位数 | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-线路总费用（元）` | `nonporkScheduleTotalCost` | 非猪肉仓-线路总费用（元） | 当前 Registry 无 code/同名替代 |
| `metrics/非猪肉仓-重量里程（kg·km）` | `nonporkWeightMileage` | 非猪肉仓-重量里程（kg·km） | 当前 Registry 无 code/同名替代 |
| `metrics/顾客类门店退货额` | `customerStoreReturnAmtShop` | 顾客类门店退货额 | 当前 Registry 仍存在：`customerStoreReturnAmtShop` |
| `metrics/顾客退货率（金额）` | `customerStoreReturnAmtShopPerOutStockPayAmt` | 顾客退货率（金额） | 当前 Registry 无 code/同名替代 |

### 删除文档当前无 Registry code 或同名替代

- `absPickShortQtyPlusPickMoreQtyPerStoreOrderWeightNotkg`
- `absPickShortWeightAmtPlusAbsPickShortQtyAmtPlusPickMoreWeightAmtPlusPickMoreQtyAmt`
- `absPickShortWeightPlusPickMoreWeightPerStoreOrderWeightKg`
- `activeMemberNum`
- `allNumWms`
- `areaEffective`
- `bf19CategoryStoreCustRate`
- `brandProductEffectiveness`
- `breakEvenPoint`
- `churnedMemberNum`
- `communityUserNum`
- `companyAllowanceFee`
- `companyAllowanceFeeRate`
- `companyBusinessIncome`
- `companyLogisticsFee`
- `companyLogisticsFeeRate`
- `companyOtherFee`
- `companyOtherFeeRate`
- `companyProfit`
- `companyPromotionAllowanceFee`
- `companyPromotionAllowanceFeeRate`
- `companyPromotionFee`
- `companyPromotionFeeRate`
- `companyRentFee`
- `companyRentFeeRate`
- `companyStaffFee`
- `companyStaffFeeRate`
- `companyTotalFee`
- `companyTotalFeeRate`
- `countStore`
- `custPenetrationRate`
- `customerStoreReturnAmtShopPerOutStockPayAmt`
- `deliveryStoreTimes`
- `deliveryStoreTimesMinusLateStoreTimesPerDeliveryStoreTimes`
- `directLaborHours`
- `directLaborHoursPerLaborHours`
- `directStoreIncome`
- `directStoreProfitAmt`
- `donoCnt`
- `dormantMemberNum`
- `ebitdaCompanyProfit`
- `financeScmIncome`
- `financeScmProfit`
- `firstTranMemberNum`
- `firstTranMemberPerCustAmt`
- `fruitOutStockWeightWms`
- `fruitOutStockWeightWmsPerOutStockWeightWms`
- `indicator_cabinet_num`
- `indicator_sale_mode_pit_production`
- `laborEffective`
- `laborHours`
- `laborHoursPer8`
- `lateArrivalCount`
- `lateStoreTimes`
- `logistics_metric_033`
- `logistics_metric_068`
- `logistics_metric_069`
- `logistics_metric_083`
- `manageFranchiseFee`
- `memberNum`
- `netProfit`
- `nonporkDonoCnt`
- `nonporkLargeVehicleDonoCnt`
- `nonporkLargeVehicleScheduleTotalCost`
- `nonporkLargeVehicleScheduleTotalCostPerDonoCnt`
- `nonporkLargeVehicleScheduleTotalCostPerStoreNum`
- `nonporkLargeVehicleScheduleTotalCostPerWeightMileage`
- `nonporkLargeVehicleShopNum`
- `nonporkLargeVehicleShopNumPerDonoCnt`
- `nonporkLargeVehicleStoreNum`
- `nonporkLargeVehicleWeightMileage`
- `nonporkLargeVehicleWmsLoadWeight`
- `nonporkLargeVehicleWmsLoadWeightPerDonoCnt`
- `nonporkScheduleTotalCost`
- `nonporkScheduleTotalCostPerDonoCnt`
- `nonporkScheduleTotalCostPerStoreNum`
- `nonporkScheduleTotalCostPerWeightMileage`
- `nonporkSmallVehicleDonoCnt`
- `nonporkSmallVehicleScheduleTotalCost`
- `nonporkSmallVehicleScheduleTotalCostPerDonoCnt`
- `nonporkSmallVehicleScheduleTotalCostPerStoreNum`
- `nonporkSmallVehicleScheduleTotalCostPerWeightMileage`
- `nonporkSmallVehicleShopNum`
- `nonporkSmallVehicleShopNumPerDonoCnt`
- `nonporkSmallVehicleStoreNum`
- `nonporkSmallVehicleWeightMileage`
- `nonporkSmallVehicleWmsLoadWeight`
- `nonporkSmallVehicleWmsLoadWeightPerDonoCnt`
- `nonporkStoreNum`
- `nonporkWeightMileage`
- `nonporkWmsLoadWeightTon`
- `offlineSkuCnt`
- `onlineOutStockWeightWms`
- `onlineOutStockWeightWmsPerOutStockWeightWms`
- `onlineSkuCnt`
- `ontimeNumWms`
- `ontimeNumWmsPerAllNumWms`
- `orderArticleRate`
- `otherBusinessProfit`
- `otherOutStockWeightWms`
- `otherOutStockWeightWmsPerOutStockWeightWms`
- `otherStoreReturnAmtShopPerOutStockPayAmt`
- `outStockCopiesWmsPerLaborHours`
- `outStockPayAmtNotaxMinusPorkOutStockPayAmtNotax`
- `outStockPayAmtNotaxPerWeightWms`
- `outStockWeightWmsMinusPorkOutStockWeightWmsPerCountStore`
- `outStockWeightWmsPerCountStore`
- `outStockWeightWmsPerLaborHours`
- `outStockWeightWmsTon`
- `pickMoreQty`
- `pickMoreQtyAmt`
- `pickMoreWeight`
- `pickMoreWeightAmt`
- `pickShortQty`
- `pickShortQtyAmt`
- `pickShortWeight`
- `pickShortWeightAmt`
- `porkDonoCnt`
- `porkOutCount`
- `porkOutCountPerDonoCnt`
- `porkOutStockPayAmtNotax`
- `porkOutStockWeightWms`
- `porkOutStockWeightWmsPerCountStore`
- `porkOutStockWeightWmsPerOutStockWeightWms`
- `porkRealShopNum`
- `porkRealShopNumPerDonoCnt`
- `porkScheduleTotalCost`
- `porkScheduleTotalCostPerDonoCnt`
- `porkScheduleTotalCostPerStoreNum`
- `porkScheduleTotalCostPerWeightMileage`
- `porkStoreNum`
- `porkWeightMileage`
- `porkWmsLoadWeightTon`
- `qualityStoreReturnAmtShopPerOutStockPayAmt`
- `quantityStoreReturnAmtShopPerOutStockPayAmt`
- `reachMemberNum`
- `regularActiveMemberNum`
- `regularActiveMemberPerCustAmt`
- `regularActiveMemberTranTimes`
- `scheduleTotalCost`
- `scheduleTotalCostPerDonoCnt`
- `scheduleTotalCostPerStoreNum`
- `seafoodOutStockWeightWms`
- `seafoodOutStockWeightWmsPerOutStockWeightWms`
- `skuOver1000Cnt`
- `spec_cmr_member_s_cross_member_num`
- `spec_cmr_member_s_member_sale_amt_rate`
- `spec_cmr_member_s_offline_member_num`
- `spec_cmr_member_s_online_member_num`
- `stop30dayStores`
- `storeArea`
- `storeCanOrders`
- `storeNum`
- `storeNumIndicators`
- `storeOrderWeightKg`
- `storeOrderWeightNotkg`
- `storeReturnAmtShopPerOutStockPayAmt`
- `tempFailCnt`
- `tempLineCnt`
- `tempPassCnt`
- `tempPassCntPerLineCnt`
- `usualResidents`
- `vegetableOutStockWeightWms`
- `vegetableOutStockWeightWmsPerOutStockWeightWms`
- `vip1ActiveMemberNum`
- `vip1ActiveMemberPerCustAmt`
- `vip1ActiveMemberTranTimes`
- `vip2ActiveMemberNum`
- `vip2ActiveMemberPerCustAmt`
- `vip2ActiveMemberTranTimes`
- `vip3ActiveMemberNum`
- `vip3ActiveMemberPerCustAmt`
- `vip3ActiveMemberTranTimes`
- `wmsLoadWeightTon`

## 当前 Registry 尚未进入 Wiki union

- `accessAdjustCostNotax`
- `accessAdjustIncomeNotax`

## 删除 Report 的 code 覆盖

| Report | 当前 Registry/Composite code 数 | 缺失 code 数 | 缺失 code |
| --- | ---: | ---: | --- |
| `主推时令大单品` | 10 | 0 | - |
| `物流中心日报` | 1 | 66 | `absPickShortQtyPlusPickMoreQtyPerStoreOrderWeightNotkg`, `absPickShortWeightAmtPlusAbsPickShortQtyAmtPlusPickMoreWeightAmtPlusPickMoreQtyAmt`, `absPickShortWeightPlusPickMoreWeightPerStoreOrderWeightKg`, `countStore`, `customerStoreReturnAmtShopPerOutStockPayAmt`, `deliveryStoreTimesMinusLateStoreTimesPerDeliveryStoreTimes`, `directLaborHoursPerLaborHours`, `donoCnt`, `fruitOutStockWeightWmsPerOutStockWeightWms`, `laborHours`, `laborHoursPer8`, `lateArrivalCount`, `logistics_metric_033`, `logistics_metric_068`, `logistics_metric_069`, `logistics_metric_083`, `nonporkDonoCnt`, `nonporkLargeVehicleDonoCnt`, `nonporkLargeVehicleScheduleTotalCostPerDonoCnt`, `nonporkLargeVehicleScheduleTotalCostPerStoreNum`, `nonporkLargeVehicleScheduleTotalCostPerWeightMileage`, `nonporkLargeVehicleShopNumPerDonoCnt`, `nonporkLargeVehicleWmsLoadWeightPerDonoCnt`, `nonporkScheduleTotalCostPerDonoCnt`, `nonporkScheduleTotalCostPerStoreNum`, `nonporkScheduleTotalCostPerWeightMileage`, `nonporkSmallVehicleDonoCnt`, `nonporkSmallVehicleScheduleTotalCostPerDonoCnt`, `nonporkSmallVehicleScheduleTotalCostPerStoreNum`, `nonporkSmallVehicleScheduleTotalCostPerWeightMileage`, `nonporkSmallVehicleShopNumPerDonoCnt`, `nonporkSmallVehicleWmsLoadWeightPerDonoCnt`, `nonporkWmsLoadWeightTon`, `offlineSkuCnt`, `onlineOutStockWeightWmsPerOutStockWeightWms`, `onlineSkuCnt`, `ontimeNumWmsPerAllNumWms`, `otherOutStockWeightWmsPerOutStockWeightWms`, `otherStoreReturnAmtShopPerOutStockPayAmt`, `outStockCopiesWmsPerLaborHours`, `outStockPayAmtNotaxMinusPorkOutStockPayAmtNotax`, `outStockPayAmtNotaxPerWeightWms`, `outStockWeightWmsMinusPorkOutStockWeightWmsPerCountStore`, `outStockWeightWmsPerCountStore`, `outStockWeightWmsPerLaborHours`, `outStockWeightWmsTon`, `porkDonoCnt`, `porkOutCountPerDonoCnt`, `porkOutStockPayAmtNotax`, `porkOutStockWeightWmsPerCountStore`, `porkOutStockWeightWmsPerOutStockWeightWms`, `porkRealShopNumPerDonoCnt`, `porkScheduleTotalCostPerDonoCnt`, `porkScheduleTotalCostPerStoreNum`, `porkScheduleTotalCostPerWeightMileage`, `porkWmsLoadWeightTon`, `qualityStoreReturnAmtShopPerOutStockPayAmt`, `quantityStoreReturnAmtShopPerOutStockPayAmt`, `scheduleTotalCostPerDonoCnt`, `scheduleTotalCostPerStoreNum`, `seafoodOutStockWeightWmsPerOutStockWeightWms`, `skuOver1000Cnt`, `storeReturnAmtShopPerOutStockPayAmt`, `tempPassCntPerLineCnt`, `vegetableOutStockWeightWmsPerOutStockWeightWms`, `wmsLoadWeightTon` |
| `用户分析报告` | 1 | 24 | `activeMemberNum`, `churnedMemberNum`, `communityUserNum`, `crossMemberNum`, `dormantMemberNum`, `firstTranMemberNum`, `firstTranMemberPerCustAmt`, `memberNum`, `memberSaleAmtRate`, `offlineMemberNum`, `onlineMemberNum`, `reachMemberNum`, `regularActiveMemberNum`, `regularActiveMemberPerCustAmt`, `regularActiveMemberTranTimes`, `vip1ActiveMemberNum`, `vip1ActiveMemberPerCustAmt`, `vip1ActiveMemberTranTimes`, `vip2ActiveMemberNum`, `vip2ActiveMemberPerCustAmt`, `vip2ActiveMemberTranTimes`, `vip3ActiveMemberNum`, `vip3ActiveMemberPerCustAmt`, `vip3ActiveMemberTranTimes` |
| `经营综合分析报告` | 24 | 5 | `bf19CategoryStoreCustRate`, `brandProductEffectiveness`, `custPenetrationRate`, `orderArticleRate`, `storeCanOrders` |
| `财务分析报告` | 0 | 25 | `companyAllowanceFee`, `companyAllowanceFeeRate`, `companyBusinessIncome`, `companyLogisticsFee`, `companyLogisticsFeeRate`, `companyOtherFee`, `companyOtherFeeRate`, `companyProfit`, `companyPromotionAllowanceFee`, `companyPromotionAllowanceFeeRate`, `companyPromotionFee`, `companyPromotionFeeRate`, `companyRentFee`, `companyRentFeeRate`, `companyStaffFee`, `companyStaffFeeRate`, `companyTotalFee`, `companyTotalFeeRate`, `directStoreIncome`, `directStoreProfitAmt`, `ebitdaCompanyProfit`, `financeScmIncome`, `financeScmProfit`, `manageFranchiseFee`, `otherBusinessProfit` |
| `门店分析报告` | 8 | 10 | `areaEffective`, `breakEvenPoint`, `laborEffective`, `netProfit`, `stop30dayStores`, `storeArea`, `storeDormTotalRent`, `storeNum`, `storeOtherFee`, `storeTotalSalary` |
| `门店周边画像分析报告` | 0 | 4 | `daily_passenger_flow`, `region_area`, `resident_or_flow`, `resident_population` |

## 结论

该报告是只读盘点结果，不执行恢复。Metric 恢复必须以 wikis 元数据成功、真实 analysis execute 成功、参数/维度/统计策略/输出契约均迁移完成为准；仅 Registry 存在不能证明可恢复。

可复用流程：

```text
git diff --name-only --diff-filter=D HEAD -- metrics reports dims
git show HEAD:metrics/<dir>/spec.md -> 读取历史 frontmatter name/label
qdm-metric-cli metric search --limit 500 --output envelope
qdm-metric-cli wikis --code <code> --output envelope
qdm-metric-cli analysis execute ... --output envelope
registry_codes - (direct_manifest_codes union composite_codes)
```
