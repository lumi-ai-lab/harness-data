# 中上门店不良率指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取中上门店不良率（`upperLossRate`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。
> 品类口径固定为全品类，不支持品类下钻。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code upperLossRate --full
```

返回字段：`indicatorsName`（中上门店不良率）、`businessDefinition`（中上门店中不良门店的占比）、`indicatorBiz`（门店盈利与运营效率）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、全品类、昨天）

```bash
qdm-cmr-cli report store indicators --indicator upperLossRate --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **品类口径**：固定全品类，不支持品类过滤。

### 返回数据结构

```json
{
  "indicatorCode": "upperLossRate",
  "indicatorName": "中上门店不良率",
  "value": 0.1120,            // 当前值（valueUnit=3，需×100=11.20%）
  "valueUnit": 3,              // 单位类型（3=小数形式的比率，需×100转为百分比）
  "mom": {
    "value": 0.0012,          // 环比变动（+0.12个百分点）
    "status": "up",
    "unit": 3
  },
  "yoy": {
    "value": -0.0008,         // 同比变动（-0.08个百分点）
    "status": "down",
    "unit": 3
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如客数、门店数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1120 表示 11.20%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化
- `unit: 3` — 小数形式的比率变化（百分点变化，如 -0.0008 表示 -0.08 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report store trend --indicator upperLossRate
```

返回最近约 30 天的逐日中上门店不良率数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 0.1120,       // 当前周期值（需×100）
      "compare": 0.1128        // 同比对照值（去年同期）
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report store area --indicator upperLossRate
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的中上门店不良率排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 0.1080,
      "yoy": { "value": -0.0015 },
      "mom": { "value": 0.0025 }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 0.1210,
      "yoy": { "value": 0.0020 },
      "mom": { "value": -0.0010 }
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
| `--area` | 对应类型的 ID 或名称 | `--area CN00` / `--area 华东` | 具体区域 |

- `--area-type` 和 `--area` 必须**成对使用**，不能只传一个。
- **默认**：`--area-type 管理区域 --area CN00`（全国不含港澳）。
- 常见 `--area-type` 映射：
  - `管理区域` → `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` → `groupManagerId`（如 Q027115 等督导编码）
  - `大区` → `manageRegionId`
  - `门店` → `storeId`

### 5.3 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

---

## 六、完整示例

### 示例 1：默认查询（全国、全品类、昨天、含同比环比）

```bash
qdm-cmr-cli report store indicators \
  --indicator upperLossRate \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 全量

```bash
# 指标值
qdm-cmr-cli report store indicators \
  --indicator upperLossRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report store trend \
  --indicator upperLossRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15

# 区域表现
qdm-cmr-cli report store area \
  --indicator upperLossRate \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report store indicators \
  --indicator upperLossRate \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report store overview \
  --indicator upperLossRate \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 三类数据，适合报告生成场景。

---

## 七、注意事项

1. **valueUnit=3**：中上门店不良率的 valueUnit 为 3（小数比率），需 ×100 转为百分比显示。如 `0.1120` 表示 11.20%。
2. **同比/环比 unit=3**：yoy/mom 中的 value 也是小数形式，表示百分点的变化。
3. **反向指标**：不良率为反向指标，越低越好。中上门店不良率通常介于头部和尾部之间，需关注是否向尾部恶化。
4. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
5. 同比/环比中的 `status` 字段（`up`/`down`/`flat`）表示箭头指向，不代表数值正负。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 区域过滤条件在所有子命令（`indicators`/`area`/`trend`/`overview`）中通用。
8. 品类口径固定为全品类，无品类过滤参数，不支持品类维度下钻。
9. 所有数据均来自 `qdm-cmr-cli report store`，报告 `/report/1` 对应门店管理页面。