# vip1活跃会员客单价取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取 vip1活跃会员客单价（`vip1ActiveMemberPerCustAmt`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code vip1ActiveMemberPerCustAmt --full
```

返回字段：`indicatorsName`（vip1活跃会员客单价）、`businessDefinition`（会员等级为vip1会员的活跃会员，他们产生的订单的平均销售额）、`statisticalLogic`（vip1活跃会员销售额 / vip1活跃会员来客数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator vip1ActiveMemberPerCustAmt --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **用户报表不支持品类过滤**。

### 返回数据结构

```json
{
  "indicatorCode": "vip1ActiveMemberPerCustAmt",
  "indicatorName": "vip1活跃会员客单价",
  "value": 25.954736,
  "valueUnit": 2,
  "mom": {
    "value": -0.0661,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.0091,
    "status": "up",
    "unit": 2
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如会员数、用户数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 25.95 表示客单价为 25.95 元）
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 `-0.0661` 表示 -6.61%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator vip1ActiveMemberPerCustAmt
```

返回最近约 30 天的逐日 vip1活跃会员客单价数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/04/25",
      "current": 29.0025,
      "compare": 25.0475
    },
    {
      "period": "2026/05/24",
      "current": 25.9547,
      "compare": 28.8090
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator vip1ActiveMemberPerCustAmt
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的 vip1活跃会员客单价排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 28.5968,
      "mom": { "value": -0.0585 },
      "yoy": { "value": 0.0040 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 28.1781,
      "mom": { "value": 0.0651 },
      "yoy": { "value": 0.0244 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 27.2794,
      "mom": { "value": -0.0721 },
      "yoy": { "value": 0.1506 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 26.2172,
      "mom": { "value": -0.0863 },
      "yoy": { "value": 0.0047 }
    }
  ]
}
```

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

### 5.3 品类过滤

用户报表**不支持**品类过滤。不需要传 `--category-type` 和 `--category` 参数。

### 5.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

---

## 六、完整示例

### 示例 1：默认查询（全国、昨天、含同比环比）

```bash
qdm-cmr-cli report user indicators \
  --indicator vip1ActiveMemberPerCustAmt \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report user indicators \
  --indicator vip1ActiveMemberPerCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report user trend \
  --indicator vip1ActiveMemberPerCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01

# 区域表现
qdm-cmr-cli report user area \
  --indicator vip1ActiveMemberPerCustAmt \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01
```

### 示例 3：月度汇总 + 华东区域

```bash
qdm-cmr-cli report user indicators \
  --indicator vip1ActiveMemberPerCustAmt \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator vip1ActiveMemberPerCustAmt \
  --date 2026-05-24
```

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
3. 用户报表**不支持品类过滤**，无需传递 `--category-type` 和 `--category` 参数。
4. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
5. 区域过滤条件在所有子命令（`indicators`/`area`/`trend`/`overview`）中通用。
6. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户报表页面。
7. vip1活跃会员客单价的 `valueUnit: 2`，`value: 25.95` 表示 VIP1 活跃会员平均每单消费约 25.95 元。