# 用户报表指标 Spec/Playbook/Template 补全任务

> 本文件记录用户报表（`/report/3`）下每个指标的 `s-` 前缀三件套（spec、playbook、template）的完成进度。
>
> 执行方式：对每个未完成的指标，使用 `/data-harness-single` Skill 生成对应文件。
>
> 指标来源：`qdm-cmr-cli report user tree`（2026-05-25 获取）。

## 与经营分析报表的关键差异

- **无品类表现图**：用户报表没有品类（category）维度，playbook 和 template 中不需要品类相关章节。
- **数据获取命令**：`qdm-cmr-cli report user` 替代 `qdm-cmr-cli report business`。
- **时间/区域过滤**：支持 `--date`/`--week`/`--month` 和 `--area-type`/`--area`。

## 进度总览

- 总指标数：**32**
- 已完成：**0**
- 待处理：**32**

---

## 一、活跃用户数维度（24 个指标）

### 一级核心指标

- [ ] **1. activeMemberNum — 活跃用户数**
  - 文件：`s-active-member-num.md`
  - 父指标：无（一级核心，showTable）
  - 子指标：新消费用户数、普通活跃会员数、vip1活跃会员数、vip2活跃会员数、vip3活跃会员数、休眠期会员数、流失期用户数、可触达用户数
  - 状态：待处理

### 新消费用户

- [ ] **2. firstTranMemberNum — 新消费用户数**
  - 文件：`s-first-tran-member-num.md`
  - 父指标：活跃用户数
  - 子指标：新客首单客单价、次月留存率
  - 状态：待处理

- [ ] **3. firstTranMemberPerCustAmt — 新客首单客单价**
  - 文件：`s-first-tran-member-per-cust-amt.md`
  - 父指标：新消费用户数
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **4. nextMonthRetainedRate — 次月留存率**
  - 文件：`s-next-month-retained-rate.md`
  - 父指标：新消费用户数
  - 子指标：无（叶子指标）
  - 状态：待处理

### 普通活跃会员

- [ ] **5. regularActiveMemberNum — 普通活跃会员数**
  - 文件：`s-regular-active-member-num.md`
  - 父指标：活跃用户数
  - 子指标：普通活跃会员消费频次、普通活跃会员客单价
  - 状态：待处理

- [ ] **6. regularActiveMemberTranTimes — 普通活跃会员消费频次**
  - 文件：`s-regular-active-member-tran-times.md`
  - 父指标：普通活跃会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **7. regularActiveMemberPerCustAmt — 普通活跃会员客单价**
  - 文件：`s-regular-active-member-per-cust-amt.md`
  - 父指标：普通活跃会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

### VIP1 活跃会员

- [ ] **8. vip1ActiveMemberNum — vip1活跃会员数**
  - 文件：`s-vip1-active-member-num.md`
  - 父指标：活跃用户数
  - 子指标：vip1活跃会员消费频次、vip1活跃会员客单价
  - 状态：待处理

- [ ] **9. vip1ActiveMemberTranTimes — vip1活跃会员消费频次**
  - 文件：`s-vip1-active-member-tran-times.md`
  - 父指标：vip1活跃会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **10. vip1ActiveMemberPerCustAmt — vip1活跃会员客单价**
  - 文件：`s-vip1-active-member-per-cust-amt.md`
  - 父指标：vip1活跃会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

### VIP2 活跃会员

- [ ] **11. vip2ActiveMemberNum — vip2活跃会员数**
  - 文件：`s-vip2-active-member-num.md`
  - 父指标：活跃用户数
  - 子指标：vip2活跃会员消费频次、vip2活跃会员客单价
  - 状态：待处理

- [ ] **12. vip2ActiveMemberTranTimes — vip2活跃会员消费频次**
  - 文件：`s-vip2-active-member-tran-times.md`
  - 父指标：vip2活跃会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **13. vip2ActiveMemberPerCustAmt — vip2活跃会员客单价**
  - 文件：`s-vip2-active-member-per-cust-amt.md`
  - 父指标：vip2活跃会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

### VIP3 活跃会员

- [ ] **14. vip3ActiveMemberNum — vip3活跃会员数**
  - 文件：`s-vip3-active-member-num.md`
  - 父指标：活跃用户数
  - 子指标：vip3活跃会员消费频次、vip3活跃会员客单价
  - 状态：待处理

- [ ] **15. vip3ActiveMemberTranTimes — vip3活跃会员消费频次**
  - 文件：`s-vip3-active-member-tran-times.md`
  - 父指标：vip3活跃会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **16. vip3ActiveMemberPerCustAmt — vip3活跃会员客单价**
  - 文件：`s-vip3-active-member-per-cust-amt.md`
  - 父指标：vip3活跃会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

### 休眠与流失

- [ ] **17. dormantMemberNum — 休眠期会员数**
  - 文件：`s-dormant-member-num.md`
  - 父指标：活跃用户数
  - 子指标：用户挽回率
  - 状态：待处理

- [ ] **18. winbackMemberRate — 用户挽回率**
  - 文件：`s-winback-member-rate.md`
  - 父指标：休眠期会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **19. churnedMemberNum — 流失期用户数**
  - 文件：`s-churned-member-num.md`
  - 父指标：活跃用户数
  - 子指标：无（叶子指标）
  - 状态：待处理

### 可触达用户

- [ ] **20. reachMemberNum — 可触达用户数**
  - 文件：`s-reach-member-num.md`
  - 父指标：活跃用户数
  - 子指标：会员数、社群用户数、官媒用户数、抖音用户数
  - 状态：待处理

- [ ] **21. memberNum — 会员数**
  - 文件：`s-member-num.md`
  - 父指标：可触达用户数
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **22. communityUserNum — 社群用户数**
  - 文件：`s-community-user-num.md`
  - 父指标：可触达用户数
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **23. officialMediaUserNum — 官媒用户数**
  - 文件：`s-official-media-user-num.md`
  - 父指标：可触达用户数
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **24. douyinUserNum — 抖音用户数**
  - 文件：`s-douyin-user-num.md`
  - 父指标：可触达用户数
  - 子指标：无（叶子指标）
  - 状态：待处理

---

## 二、会员复购率维度（3 个指标）

### 一级核心指标

- [ ] **25. memberRepurchaseNoDifferenceRate — 会员复购率**
  - 文件：`s-member-repurchase-no-difference-rate.md`
  - 父指标：无（一级核心，showTable）
  - 子指标：复购会员数、消费会员数、复购会员消费频次
  - 状态：待处理

- [ ] **26. repurchaseMemberNum — 复购会员数**
  - 文件：`s-repurchase-member-num.md`
  - 父指标：会员复购率
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **27. buyMemberNum — 消费会员数**
  - 文件：`s-buy-member-num.md`
  - 父指标：会员复购率
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **28. memberRepurchaseTranTimes — 复购会员消费频次**
  - 文件：`s-member-repurchase-tran-times.md`
  - 父指标：会员复购率
  - 子指标：无（叶子指标）
  - 状态：待处理

---

## 三、会员销售占比维度（4 个指标）

### 一级核心指标

- [ ] **29. memberSaleAmtRate — 会员销售占比**
  - 文件：`s-member-sale-amt-rate.md`
  - 父指标：无（一级核心，showTable）
  - 子指标：交叉会员数
  - 状态：待处理

- [ ] **30. crossMemberNum — 交叉会员数**
  - 文件：`s-cross-member-num.md`
  - 父指标：会员销售占比
  - 子指标：线下消费会员数、线上消费会员数
  - 状态：待处理

- [ ] **31. offlineMemberNum — 线下消费会员数**
  - 文件：`s-offline-member-num.md`
  - 父指标：交叉会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

- [ ] **32. onlineMemberNum — 线上消费会员数**
  - 文件：`s-online-member-num.md`
  - 父指标：交叉会员数
  - 子指标：无（叶子指标）
  - 状态：待处理

---

## 附录：文件路径说明

```
spec/member/s-<kebab-code>.md
playbook/member/s-<kebab-code>.md
templates/member/s-<kebab-code>.md
```

kebab-case 转换：驼峰处插入 `-`，全小写。
- `activeMemberNum` -> `active-member-num`
- `vip1ActiveMemberPerCustAmt` -> `vip1-active-member-per-cust-amt`

## 附录：Playbook 注意事项

- 无品类（category）图表 → playbook 跳过"五、获取品类表现数据"章节
- Template 中的区域/趋势分析同理，不包含品类拆解
- 数据命令前缀为 `qdm-cmr-cli report user`

## 附录：执行命令参考

对任意待处理指标，使用 Skill：
```
/data-harness-single
```