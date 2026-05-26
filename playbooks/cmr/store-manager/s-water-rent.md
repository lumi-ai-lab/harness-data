# 店铺水电费指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取店铺水电费（`waterRent`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code waterRent --full
```

返回字段：`indicatorsName`（店铺水电费）、`businessDefinition`（门店水电费用合计（万元））、`statisticalLogic`（统计周期内门店水费与电费合计）、`indicatorBiz`（门店管理）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report store indicators --indicator waterRent --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。

### 返回数据结构

```json
{
  "indicatorCode": "waterRent",
  "indicatorName": "店铺水电费",
  "value": 101.02,
  "valueUnit": 2,
  "mom": {
    "value": 0,
    "status": "down",
    "unit": 2
  },
  "yoy": {
    "value": 0,
    "status": "down",
    "unit": 2
  },
  "threshold": {
    "compareSymbol": "LE",
    "compareValue1": 150,
    "compareValue2": 150
  }
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` -- 整数值（如客数、门店数）
- `valueUnit: 2` -- 百分比/比率/金额（直接用值，如 101.02 表示店铺水电费为 101.02 万元）
- `valueUnit: 3` -- 小数形式的比率（需 x100 转为百分比，如 0.2646 表示 26.46%）

**同比/环比的 value**：
- `unit: 1` -- 绝对变化量（如 `+0.25` 分）
- `unit: 2` -- 比率变化（如 `-0.039` 表示 -3.9%）
- `unit: 3` -- 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report store trend --indicator waterRent
```

返回最近约 30 天的逐日店铺水电费数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/05/24",
      "current": 101.02,
      "compare": 101.02
    }
  ]
}
```

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report store area --indicator waterRent
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的店铺水电费排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 101.02,
      "yoy": { "value": 0 },
      "mom": { "value": 0 }
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
  - `管理区域` -> `manageAreaId`（如 CN00 全国、CN15 华东、CN01 粤西、CN18 粤东）
  - `督导` -> `groupManagerId`（如 Q027115 等督导编码）
  - `大区` -> `manageRegionId`
  - `门店` -> `storeId`

### 5.3 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |
| `--display-mode thresholdRatio` | 返回阈值比率数据 |

**默认**：不返回同比环比（需显式指定 `--display-mode yoyMom`）。

---

## 六、完整示例

### 示例 1：默认查询（全国、昨天、含同比环比）

```bash
qdm-cmr-cli report store indicators \
  --indicator waterRent \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 华东区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report store indicators \
  --indicator waterRent \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report store trend \
  --indicator waterRent \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15

# 区域表现（在华东范围内按督导下钻）
qdm-cmr-cli report store area \
  --indicator waterRent \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN15
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report store indicators \
  --indicator waterRent \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report store overview \
  --indicator waterRent \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 三类数据，适合报告生成场景。

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "down"` 且 `value: 0` 表示箭头向下但无变化。
3. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
4. 区域过滤条件在所有子命令（`indicators`/`area`/`trend`/`overview`）中通用。
5. 所有数据均来自 `qdm-cmr-cli report store`，报告 `/report/1` 对应门店管理页面。
6. 店铺水电费为叶子指标，无需获取品类表现数据。