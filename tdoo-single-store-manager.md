# 门店管理指标 Spec/Playbook/Template 补全任务

> 本文件记录门店管理（`/report/1`）下每个指标的 `s-` 前缀三件套（spec、playbook、template）的完成进度。
>
> 执行方式：对每个未完成的指标，使用 `/data-harness-single` Skill 生成对应文件。
>
> 指标来源：`qdm-cmr-cli report store tree`（2026-05-25 获取）。

## 与经营分析报表的关键差异

- **无品类表现图**：门店管理报表没有品类（category）维度，playbook 和 template 中不需要品类相关章节。
- **数据获取命令**：`qdm-cmr-cli report store` 替代 `qdm-cmr-cli report business`。
- **时间/区域过滤**：支持 `--date`/`--week`/`--month` 和 `--area-type`/`--area`。

## 进度总览

- 总指标数：**23**
- 已完成：**23**
- 待处理：**0**

---

## 一、营业门店数维度（8 个指标）✅ 已全部完成

### 一级核心指标

- [x] **1. stores — 营业门店数**
  - 文件：`s-stores.md`
  - 父指标：无（一级核心，showTable）
  - 子指标：净增门店数、存量门店数、停业门店数
  - 状态：✅ 已完成

### 门店增减

- [x] **2. increaseStores — 净增门店数**
  - 文件：`s-increase-stores.md`
  - 父指标：营业门店数
  - 子指标：开店数、闭店数
  - 状态：✅ 已完成

- [x] **3. openStores — 开店数**
  - 文件：`s-open-stores.md`
  - 父指标：净增门店数
  - 子指标：待开业门店数
  - 状态：✅ 已完成

- [x] **4. unopenStores — 待开业门店数**
  - 文件：`s-unopen-stores.md`
  - 父指标：开店数
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

- [x] **5. closeStores — 闭店数**
  - 文件：`s-close-stores.md`
  - 父指标：净增门店数
  - 子指标：停业超30天门店数
  - 状态：✅ 已完成

- [x] **6. stop30dayStores — 停业超30天门店数**
  - 文件：`s-stop30day-stores.md`
  - 父指标：闭店数
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

### 门店存量

- [x] **7. stockStores — 存量门店数**
  - 文件：`s-stock-stores.md`
  - 父指标：营业门店数
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

- [x] **8. stopBusinessStores — 停业门店数**
  - 文件：`s-stop-business-stores.md`
  - 父指标：营业门店数
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

---

## 二、门店净利润维度（15 个指标）✅ 已全部完成

### 一级核心指标

- [x] **9. netProfit — 门店净利润**
  - 文件：`s-net-profit.md`
  - 父指标：无（一级核心，showTable）
  - 子指标：盈亏平衡点、坪效、人效
  - 状态：✅ 已完成

### 盈亏平衡与不良率

- [x] **10. breakEvenPoint — 盈亏平衡点**
  - 文件：`s-break-even-point.md`
  - 父指标：门店净利润
  - 子指标：不良率、员工工资、租金和物业管理费、店铺水电费、门店其他支出
  - 状态：✅ 已完成

- [x] **11. lossRate — 不良率**
  - 文件：`s-loss-rate.md`
  - 父指标：盈亏平衡点（lineType: dashed）
  - 子指标：头部门店不良率、中上门店不良率、中下门店不良率、尾部门店不良率
  - 状态：✅ 已完成

- [x] **12. headLossRate — 头部门店不良率**
  - 文件：`s-head-loss-rate.md`
  - 父指标：不良率
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

- [x] **13. upperLossRate — 中上门店不良率**
  - 文件：`s-upper-loss-rate.md`
  - 父指标：不良率
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

- [x] **14. lowerLossRate — 中下门店不良率**
  - 文件：`s-lower-loss-rate.md`
  - 父指标：不良率
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

- [x] **15. tailLossRate — 尾部门店不良率**
  - 文件：`s-tail-loss-rate.md`
  - 父指标：不良率
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

### 盈亏平衡费用项

- [x] **16. storeTotalSalary — 员工工资**
  - 文件：`s-store-total-salary.md`
  - 父指标：盈亏平衡点
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

- [x] **17. storeDormTotalRent — 租金和物业管理费**
  - 文件：`s-store-dorm-total-rent.md`
  - 父指标：盈亏平衡点
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

- [x] **18. waterRent — 店铺水电费**
  - 文件：`s-water-rent.md`
  - 父指标：盈亏平衡点
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

- [x] **19. storeOtherFee — 门店其他支出**
  - 文件：`s-store-other-fee.md`
  - 父指标：盈亏平衡点
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

### 坪效与人效

- [x] **20. areaEffective — 坪效**
  - 文件：`s-area-effective.md`
  - 父指标：门店净利润
  - 子指标：门店面积
  - 状态：✅ 已完成

- [x] **21. storeArea — 门店面积**
  - 文件：`s-store-area.md`
  - 父指标：坪效
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

- [x] **22. laborEffective — 人效**
  - 文件：`s-labor-effective.md`
  - 父指标：门店净利润
  - 子指标：门店人数
  - 状态：✅ 已完成

- [x] **23. storeNum — 门店人数**
  - 文件：`s-store-num.md`
  - 父指标：人效
  - 子指标：无（叶子指标）
  - 状态：✅ 已完成

---

## 附录：文件路径说明

```
spec/store-manager/s-<kebab-code>.md
playbook/store-manager/s-<kebab-code>.md
templates/store-manager/s-<kebab-code>.md
```

kebab-case 转换同经营分析：驼峰处插入 `-`，全小写。
- `stop30dayStores` -> `stop30day-stores`（数字前不加 `-`，数字后加 `-`）

## 附录：Playbook 注意事项

- 无品类（category）图表 → playbook 跳过"五、获取品类表现数据"章节
- Template 中的区域/趋势分析同理，不包含品类拆解
- 数据命令前缀为 `qdm-cmr-cli report store`

## 附录：执行命令参考

对任意待处理指标，使用 Skill：
```
/data-harness-single
```