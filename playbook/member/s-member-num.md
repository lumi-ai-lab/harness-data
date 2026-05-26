# 会员数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取会员数（`memberNum`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。
> 用户报表 `/report/3` 不支持品类维度，本手册不包含品类过滤章节。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code memberNum --full
```

返回字段：`indicatorsName`（会员数）、`businessDefinition`（钱大妈小程序中的会员数量）、`statisticalLogic`（会员id去重计数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator memberNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。

### 返回数据结构

```json
{
  "indicatorCode": "memberNum",
  "indicatorName": "会员数",
  "value": 2612.76,
  "valueUnit": 1,
  "zhCNUnit": "万",
  "mom": {
    "value": 0.0005,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.0025,
    "status": "up",
    "unit": 2
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如会员数 2612.76，单位为 zhCNUnit 指定的"万"）
- `valueUnit: 2` — 百分比/比率（如消费频次 1.11 次）
- `valueUnit: 3` — 小数形式的比率（需乘100转为百分比）

**同比/环比的 unit**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 mom: 0.0005 表示 +0.05%）
- `unit: 3` — 小数形式的比率变化（百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator memberNum
```

返回最近 30 天的逐日会员数数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    { "period": "2026/05/24", "current": 2612.7568, "compare": 2319.8798, "unit": "万" },
    { "period": "2026/05/23", "current": 2611.44, "compare": 2318.829, "unit": "万" },
    { "period": "2026/05/22", "current": 2610.0976, "compare": 2318.148, "unit": "万" },
    { "period": "2026/05/21", "current": 2609.1887, "compare": 2317.4654, "unit": "万" },
    { "period": "2026/05/20", "current": 2608.381, "compare": 2316.7991, "unit": "万" }
  ]
}
```

- 近 30 天范围：2026/04/25 - 2026/05/24。
- 会员数从 2592.27 万增长至 2612.76 万，每日稳步增长，无明显波动。
- 同比对照（去年同期）从 2292.58 万增长至 2319.88 万，基数稳步扩大。
- 可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator memberNum
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的会员数排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01", "name": "粤西",
      "current": 816.7165, "unit": "万",
      "yoy": { "value": 0.0021548286272559335 },
      "mom": { "value": 0.0003935593937837349 }
    },
    {
      "code": "CN18", "name": "粤东",
      "current": 618.1119, "unit": "万",
      "yoy": { "value": 0.002282130258494852 },
      "mom": { "value": 0.0004238892935177935 }
    },
    {
      "code": "CN15", "name": "华东",
      "current": 260.3247, "unit": "万",
      "yoy": { "value": 0.0017335310700332457 },
      "mom": { "value": 0.00038697429906548803 }
    },
    {
      "code": "CN07", "name": "运营直管",
      "current": 5.0276, "unit": "万",
      "yoy": { "value": 0.005399352077750519 },
      "mom": { "value": 0.0007763202420526291 }
    }
  ]
}
```

- **领先区域**：粤西（816.72 万），占全国会员数的 31.3%，是会员基础最大的区域。
- **次级区域**：粤东（618.11 万），华东（260.32 万）。
- **小规模区域**：运营直管（5.03 万），但同比增速最高（+0.54%）。

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

- `--area-type` 和 `--area` 必须**成对使用**。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。

### 5.3 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

> **注意**：用户报表 `/report/3` 不支持品类过滤，无需传递 `--category-type` 和 `--category` 参数。

---

## 六、完整示例

### 示例 1：默认查询（全国、昨天、含同比环比）

```bash
qdm-cmr-cli report user indicators \
  --indicator memberNum \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤东区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report user indicators \
  --indicator memberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report user trend \
  --indicator memberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN18
```

### 示例 3：月度汇总 + 华东区域

```bash
qdm-cmr-cli report user indicators \
  --indicator memberNum \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator memberNum \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 三类数据。

---

## 七、注意事项

1. **时间默认是昨天**：不传 `--date`/`--week`/`--month` 时，CLI 自动取昨天日期。
2. **区域默认是全国**：`--area-type 管理区域 --area CN00`（全国不含港澳）。
3. **用户报表无品类维度**：不支持 `--category-type` 和 `--category` 参数。
4. 同比环比的 `status` 字段（`up`/`down`）是箭头方向，不代表数值正负。
5. `zhCNUnit: "万"` 表示 value 的单位为"万"，实际会员数为 2612.76 万。
6. 会员数无阈值配置（`threshold: null`），不做达标判断。
7. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户报表页面。