# vip3活跃会员客单价指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli report user` 获取vip3活跃会员客单价（`vip3ActiveMemberPerCustAmt`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code vip3ActiveMemberPerCustAmt --full
```

返回字段：`indicatorsName`（vip3活跃会员客单价）、`businessDefinition`（会员等级为vip3会员的活跃会员，他们产生的订单的平均销售额）、`statisticalLogic`（vip3活跃会员销售额 / vip3活跃会员来客数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator vip3ActiveMemberPerCustAmt --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **注意**：用户报表不支持品类过滤（无 `--category-type` / `--category` 参数）。

### 返回数据结构

```json
{
  "indicatorCode": "vip3ActiveMemberPerCustAmt",
  "indicatorName": "vip3活跃会员客单价",
  "value": 38.659517,
  "valueUnit": 2,
  "mom": {
    "value": -0.0832,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.0167,
    "status": "up",
    "unit": 2
  },
  "threshold": null,
  "zhCNUnit": ""
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如人数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 38.66 表示 38.66 元）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1478 表示 14.78%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 `-0.0832` 表示 -8.32%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator vip3ActiveMemberPerCustAmt
```

返回最近约 30 天的逐日数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/04/25", "current": 43.501553, "compare": 35.165003 },
    { "period": "2026/04/26", "current": 39.290846, "compare": 39.525417 },
    { "period": "2026/04/27", "current": 32.223961, "compare": 35.153492 },
    { "period": "2026/04/28", "current": 35.912507, "compare": 32.249064 },
    { "period": "2026/04/29", "current": 32.980737, "compare": 34.628774 },
    { "period": "2026/04/30", "current": 35.433393, "compare": 34.658176 },
    { "period": "2026/05/01", "current": 41.706337, "compare": 39.151852 },
    { "period": "2026/05/02", "current": 35.737022, "compare": 34.266743 },
    { "period": "2026/05/03", "current": 35.751972, "compare": 35.326086 },
    { "period": "2026/05/04", "current": 33.931985, "compare": 34.876217 },
    { "period": "2026/05/05", "current": 39.905063, "compare": 35.754904 },
    { "period": "2026/05/06", "current": 33.432142, "compare": 34.588164 },
    { "period": "2026/05/07", "current": 33.435033, "compare": 33.839629 },
    { "period": "2026/05/08", "current": 34.14474, "compare": 33.630183 },
    { "period": "2026/05/09", "current": 36.991488, "compare": 34.263582 },
    { "period": "2026/05/10", "current": 44.664201, "compare": 43.231383 },
    { "period": "2026/05/11", "current": 32.116767, "compare": 39.772739 },
    { "period": "2026/05/12", "current": 34.474886, "compare": 32.357734 },
    { "period": "2026/05/13", "current": 32.651521, "compare": 34.878521 },
    { "period": "2026/05/14", "current": 33.277882, "compare": 32.567837 },
    { "period": "2026/05/15", "current": 34.547631, "compare": 33.073105 },
    { "period": "2026/05/16", "current": 40.996222, "compare": 34.640678 },
    { "period": "2026/05/17", "current": 38.024897, "compare": 42.390817 },
    { "period": "2026/05/18", "current": 32.417535, "compare": 38.700082 },
    { "period": "2026/05/19", "current": 35.275149, "compare": 32.109454 },
    { "period": "2026/05/20", "current": 35.138198, "compare": 34.238968 },
    { "period": "2026/05/21", "current": 33.719495, "compare": 31.987632 },
    { "period": "2026/05/22", "current": 34.122112, "compare": 32.279445 },
    { "period": "2026/05/23", "current": 42.165732, "compare": 34.388593 },
    { "period": "2026/05/24", "current": 38.659517, "compare": 40.137241 }
  ]
}
```

> 近30天趋势范围：2026/04/25 ~ 2026/05/24。当前值范围 32.12~44.66 元，峰值出现在 2026/05/10（current=44.66），低谷出现在 2026/05/11（current=32.12）。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator vip3ActiveMemberPerCustAmt
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的vip3活跃会员客单价排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 40.877663,
      "yoy": { "value": 0.010465216305806671, "unit": null },
      "mom": { "value": -0.07041322017104881, "unit": null }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 39.23937,
      "yoy": { "value": 0.08878967042773145, "unit": null },
      "mom": { "value": -0.00229595118128255, "unit": null }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 37.327817,
      "yoy": { "value": 0.017656736276949702, "unit": null },
      "mom": { "value": -0.1177478853900479, "unit": null }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 35.089786,
      "yoy": { "value": 0.01023938126563113, "unit": null },
      "mom": { "value": 0.14919324439241682, "unit": null }
    }
  ]
}
```

> 排序按 current 降序。粤东（40.88元）客单价最高，华东（35.09元）最低但环比大幅增长14.92%。运营直管同比增幅最大（+8.88%）。粤西环比大幅下降11.77%。所有区域同比均正增长。

---

## 五、过滤条件说明

### 5.1 时间过滤

| 参数 | 格式 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--date` | `YYYY-MM-DD` | `--date 2026-05-24` | 指定日期（默认：昨天） |
| `--week` | `YYYY-NN` | `--week 2026-21` | 指定周（ISO 周号） |
| `--month` | `YYYY-MM` | `--month 2026-05` | 指定月份 |

> 三个时间参数互斥，只能使用其中一个。**默认**：不传任何时间参数时，取昨天日期。

### 5.2 区域过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--area-type` | `管理区域` / `督导` / `大区` / `门店` 等 | `--area-type 管理区域` | 区域维度类型 |
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 粤西` | 具体区域 |

- `--area-type` 和 `--area` 必须**成对使用**，不能只传一个。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。
- 常见 `--area-type` 映射：
  - `管理区域` → `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` → `groupManagerId`
  - `大区` → `manageRegionId`
  - `门店` → `storeId`

### 5.3 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

> **注意**：用户报表不支持品类过滤，不要使用 `--category-type` 和 `--category` 参数。

---

## 六、完整示例

### 示例 1：默认查询（全国、昨天、含同比环比）

```bash
qdm-cmr-cli report user indicators \
  --indicator vip3ActiveMemberPerCustAmt \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤东区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report user indicators \
  --indicator vip3ActiveMemberPerCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report user trend \
  --indicator vip3ActiveMemberPerCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18

# 区域表现（在粤东范围内按督导下钻）
qdm-cmr-cli report user area \
  --indicator vip3ActiveMemberPerCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18
```

### 示例 3：月度汇总 + 运营直管区域维度

```bash
qdm-cmr-cli report user indicators \
  --indicator vip3ActiveMemberPerCustAmt \
  --month 2026-05 \
  --area-type 管理区域 --area CN07 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator vip3ActiveMemberPerCustAmt \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 三类数据，适合报告生成场景。

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.0832` 表示箭头向上但数值为 -8.32%（即环比下降）。
3. vip3活跃会员客单价 `threshold` 为 null，无预设阈值。
4. vip3活跃会员客单价 `valueUnit: 2`，值为金额（如 38.66 表示 38.66 元），同比环比 unit 为 2（比率变化）。
5. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
6. 用户报表不支持品类过滤，与经营分析报表（`report business`）不同。
7. 区域过滤条件在所有子命令（`indicators`/`area`/`trend`/`overview`）中通用。
8. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户报表页面。
9. vip3活跃会员客单价为叶子指标，无下钻子指标，在报告中不需要展示父子链路表格。