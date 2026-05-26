# 会员复购率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取会员复购率（`memberRepurchaseNoDifferenceRate`）指标的详情和数据。用户报表使用 `report user` 子命令。
>
> **重要提示**：当前所有数据接口（`indicators`、`area`、`trend`）均返回空值或零值，无有效数据可用。该指标仅在 CLI 返回有值时展示。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code memberRepurchaseNoDifferenceRate --full
```

返回字段：`indicatorsName`（会员复购率）、`businessDefinition`（统计周期内，至少完成2次及以上消费的会员人数占所有消费会员总数的比，衡量会员的忠诚度）、`statisticalLogic`（复购会员数 / 会员数）、`indicatorBiz`（销售经营）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator memberRepurchaseNoDifferenceRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **用户报表不支持品类过滤**，不传 `--category-type` 和 `--category`。

### 当前返回

当前 `indicators` 子命令不返回该指标值。`area` 返回空 rows。`trend` 返回 30 天全零值。

---

## 三、获取子指标数据

会员复购率可下钻为以下子指标，可分别获取：

```bash
# 复购会员数（分子）
qdm-cmr-cli report user indicators --indicator repurchaseMemberNum --display-mode yoyMom

# 消费会员数（分母）
qdm-cmr-cli report user indicators --indicator buyMemberNum --display-mode yoyMom

# 复购会员消费频次（复购深度）
qdm-cmr-cli report user indicators --indicator memberRepurchaseTranTimes --display-mode yoyMom
```

当前仅消费会员数有实际返回值（948,937），复购会员数和复购会员消费频次均无有效数据。

---

## 四、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator memberRepurchaseNoDifferenceRate
```

当前返回 30 天全零值数据，所有 `current` 和 `compare` 均为 0，无有效趋势。

---

## 五、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator memberRepurchaseNoDifferenceRate
```

当前返回空 rows 数组，无区域数据。

---

## 六、过滤条件说明

### 6.1 时间过滤

| 参数 | 格式 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--date` | `YYYY-MM-DD` | `--date 2026-05-24` | 指定日期（默认：昨天） |
| `--week` | `YYYY-NN` | `--week 2026-21` | 指定周（ISO 周号） |
| `--month` | `YYYY-MM` | `--month 2026-05` | 指定月份 |

### 6.2 区域过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--area-type` | `管理区域` / `督导` / `大区` / `门店` 等 | `--area-type 管理区域` | 区域维度类型 |
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 粤西` | 具体区域 |

### 6.3 品类过滤

**用户报表不支持品类过滤**。不要传递 `--category-type` 或 `--category` 参数。

### 6.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |

---

## 七、注意事项

1. 当前所有数据接口均返回空值或零值，该指标无有效数据可用。
2. 报告生成时应省略此指标（遵循"指标配置存在但 CLI 没有返回值，不等于指标值为 0"原则）。
3. 会员复购率 `threshold` 为 null，无预设阈值。
4. 会员复购率是一级核心指标，可下钻到复购会员数、消费会员数、复购会员消费频次。
5. 子指标中仅消费会员数（`buyMemberNum`）当前有实际返回值。
6. 用户报表**不支持品类过滤**，不要传递 `--category-type` 或 `--category` 参数。
7. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户运营分析页面。