# vip2活跃会员消费频次取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取 vip2活跃会员消费频次（`vip2ActiveMemberTranTimes`）指标的值、趋势和区域表现数据。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code vip2ActiveMemberTranTimes --full
```

返回字段：`indicatorsName`（vip2活跃会员消费频次）、`businessDefinition`（会员等级为vip2的活跃会员，平均每位会员在统计周期内的消费次数）、`statisticalLogic`（vip2活跃会员来客数 / vip2活跃会员消费人数）。

---

## 二、获取指标值（含同比、环比）

```bash
qdm-cmr-cli report user indicators --indicator vip2ActiveMemberTranTimes --display-mode yoyMom
```

返回数据结构：

```json
{
  "indicatorCode": "vip2ActiveMemberTranTimes",
  "indicatorName": "vip2活跃会员消费频次",
  "value": 1.2480,
  "valueUnit": 2,
  "mom": { "value": -0.011, "status": "up", "unit": 2 },
  "yoy": { "value": 0.0024, "status": "up", "unit": 2 },
  "threshold": null
}
```

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator vip2ActiveMemberTranTimes
```

返回最近约 30 天的逐日数据（current 和同比对照 compare）。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator vip2ActiveMemberTranTimes
```

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN07", "name": "运营直管",
      "current": 1.2981,
      "mom": { "value": 0.0078 }, "yoy": { "value": 0.0039 }
    },
    {
      "code": "CN15", "name": "华东",
      "current": 1.2746,
      "mom": { "value": 0.0021 }, "yoy": { "value": -0.0094 }
    },
    {
      "code": "CN01", "name": "粤西",
      "current": 1.2426,
      "mom": { "value": -0.0130 }, "yoy": { "value": 0.0066 }
    },
    {
      "code": "CN18", "name": "粤东",
      "current": 1.2384,
      "mom": { "value": -0.0149 }, "yoy": { "value": 0.00003 }
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
| `--week` | `YYYY-NN` | `--week 2026-21` | 指定周 |
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
  --indicator vip2ActiveMemberTranTimes \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域

```bash
qdm-cmr-cli report user indicators \
  --indicator vip2ActiveMemberTranTimes \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --display-mode yoyMom

qdm-cmr-cli report user trend \
  --indicator vip2ActiveMemberTranTimes \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01

qdm-cmr-cli report user area \
  --indicator vip2ActiveMemberTranTimes \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01
```

### 示例 3：月度汇总

```bash
qdm-cmr-cli report user indicators \
  --indicator vip2ActiveMemberTranTimes \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：overview

```bash
qdm-cmr-cli report user overview \
  --indicator vip2ActiveMemberTranTimes \
  --date 2026-05-24
```

---

## 七、注意事项

1. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
2. 用户报表**不支持品类过滤**。
3. `--area-type` 和 `--area` 必须成对使用。
4. 所有数据均来自 `qdm-cmr-cli report user`。
5. vip2活跃会员消费频次的 `valueUnit: 2`，`value: 1.2480` 表示 VIP2 活跃会员平均消费约 1.25 次。