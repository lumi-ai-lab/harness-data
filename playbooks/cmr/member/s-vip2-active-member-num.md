# vip2活跃会员数取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取 vip2活跃会员数（`vip2ActiveMemberNum`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code vip2ActiveMemberNum --full
```

返回字段：`indicatorsName`（vip2活跃会员数）、`businessDefinition`（会员等级为VIP2的活跃会员）、`statisticalLogic`（会员等级为VIP2的活跃会员id去重计数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator vip2ActiveMemberNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **用户报表不支持品类过滤**。

### 返回数据结构

```json
{
  "indicatorCode": "vip2ActiveMemberNum",
  "indicatorName": "vip2活跃会员数",
  "value": 338402,
  "valueUnit": 1,
  "mom": {
    "value": 0.0077,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.0444,
    "status": "up",
    "unit": 2
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如会员数、用户数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator vip2ActiveMemberNum
```

返回最近约 30 天的逐日数据：

```json
{
  "rows": [
    {
      "period": "2026/04/25",
      "current": 304371,
      "compare": 344168
    },
    {
      "period": "2026/05/24",
      "current": 338402,
      "compare": 399358
    }
  ]
}
```

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator vip2ActiveMemberNum
```

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN18",
      "name": "粤东",
      "current": 137283,
      "mom": { "value": 0.0070 },
      "yoy": { "value": 0.0389 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 135910,
      "mom": { "value": 0.0072 },
      "yoy": { "value": 0.0389 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 15984,
      "mom": { "value": 0.0071 },
      "yoy": { "value": 0.0474 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 883,
      "mom": { "value": 0.0115 },
      "yoy": { "value": 0.0388 }
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

### 5.2 区域过滤

| 参数 | 可选值 | 示例 | 说明 |
| :--- | :--- | :--- | :--- |
| `--area-type` | `管理区域` / `督导` / `大区` / `门店` 等 | `--area-type 管理区域` | 区域维度类型 |
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 粤西` | 具体区域 |

- `--area-type` 和 `--area` 必须**成对使用**。

### 5.3 品类过滤

用户报表**不支持**品类过滤。

### 5.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比和环比数据 |

---

## 六、完整示例

### 示例 1：默认查询

```bash
qdm-cmr-cli report user indicators \
  --indicator vip2ActiveMemberNum \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域 + 趋势

```bash
qdm-cmr-cli report user indicators \
  --indicator vip2ActiveMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --display-mode yoyMom

qdm-cmr-cli report user trend \
  --indicator vip2ActiveMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01

qdm-cmr-cli report user area \
  --indicator vip2ActiveMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01
```

### 示例 3：月度汇总

```bash
qdm-cmr-cli report user indicators \
  --indicator vip2ActiveMemberNum \
  --month 2026-05 \
  --area-type 管理区域 --area CN18 \
  --display-mode yoyMom
```

### 示例 4：overview

```bash
qdm-cmr-cli report user overview \
  --indicator vip2ActiveMemberNum \
  --date 2026-05-24
```

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
3. 用户报表**不支持品类过滤**，无需传递 `--category-type` 和 `--category` 参数。
4. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
5. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户报表页面。
6. vip2活跃会员数的 `valueUnit: 1`，`value: 338402` 表示 338,402 人。