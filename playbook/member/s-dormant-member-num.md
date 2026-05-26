# 休眠期会员数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli report user` 获取休眠期会员数（`dormantMemberNum`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code dormantMemberNum --full
```

返回字段：`indicatorsName`（休眠期会员数）、`businessDefinition`（过去30天中没有消费，但90天内有过消费的会员数）、`statisticalLogic`（过去30天消费次数=0次且过去31-90天内有消费记录的会员id去重计数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator dormantMemberNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **注意**：用户报表不支持品类过滤（无 `--category-type` / `--category` 参数）。

### 返回数据结构

```json
{
  "indicatorCode": "dormantMemberNum",
  "indicatorName": "休眠期会员数",
  "value": 251.27,
  "valueUnit": 1,
  "zhCNUnit": "万",
  "mom": {
    "value": -0.0045,
    "status": "down",
    "unit": 2
  },
  "yoy": {
    "value": 0.0721,
    "status": "down",
    "unit": 2
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如人数，251.27 万即 2,512,700 人）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1478 表示 14.78%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 `-0.0045` 表示 -0.45%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator dormantMemberNum
```

返回最近约 30 天的逐日数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/04/25", "current": 229.1153, "compare": 221.8043, "unit": "万" },
    { "period": "2026/04/26", "current": 227.7866, "compare": 221.0737, "unit": "万" },
    { "period": "2026/04/27", "current": 229.5858, "compare": 221.8189, "unit": "万" },
    { "period": "2026/04/28", "current": 231.6462, "compare": 226.418, "unit": "万" },
    { "period": "2026/04/29", "current": 231.251, "compare": 231.4617, "unit": "万" },
    { "period": "2026/04/30", "current": 231.3301, "compare": 233.9226, "unit": "万" },
    { "period": "2026/05/01", "current": 229.7411, "compare": 236.314, "unit": "万" },
    { "period": "2026/05/02", "current": 228.7137, "compare": 238.4355, "unit": "万" },
    { "period": "2026/05/03", "current": 228.5245, "compare": 240.9, "unit": "万" },
    { "period": "2026/05/04", "current": 229.1303, "compare": 244.195, "unit": "万" },
    { "period": "2026/05/05", "current": 229.5141, "compare": 245.4225, "unit": "万" },
    { "period": "2026/05/06", "current": 230.6841, "compare": 247.6456, "unit": "万" },
    { "period": "2026/05/07", "current": 231.0584, "compare": 247.6033, "unit": "万" },
    { "period": "2026/05/08", "current": 230.4558, "compare": 247.9842, "unit": "万" },
    { "period": "2026/05/09", "current": 229.8286, "compare": 247.5552, "unit": "万" },
    { "period": "2026/05/10", "current": 228.5681, "compare": 245.768, "unit": "万" },
    { "period": "2026/05/11", "current": 230.1328, "compare": 244.5806, "unit": "万" },
    { "period": "2026/05/12", "current": 232.3522, "compare": 246.0829, "unit": "万" },
    { "period": "2026/05/13", "current": 232.1887, "compare": 247.8622, "unit": "万" },
    { "period": "2026/05/14", "current": 233.1338, "compare": 247.6871, "unit": "万" },
    { "period": "2026/05/15", "current": 233.9247, "compare": 248.8889, "unit": "万" },
    { "period": "2026/05/16", "current": 233.6928, "compare": 248.6431, "unit": "万" },
    { "period": "2026/05/17", "current": 234.3827, "compare": 246.9394, "unit": "万" },
    { "period": "2026/05/18", "current": 239.382, "compare": 245.9066, "unit": "万" },
    { "period": "2026/05/19", "current": 244.5154, "compare": 248.2976, "unit": "万" },
    { "period": "2026/05/20", "current": 246.8839, "compare": 250.9795, "unit": "万" },
    { "period": "2026/05/21", "current": 249.729, "compare": 251.3266, "unit": "万" },
    { "period": "2026/05/22", "current": 251.9557, "compare": 252.4518, "unit": "万" },
    { "period": "2026/05/23", "current": 252.4096, "compare": 252.2175, "unit": "万" },
    { "period": "2026/05/24", "current": 251.2723, "compare": 249.9492, "unit": "万" }
  ]
}
```

> 近30天趋势范围：2026/04/25 ~ 2026/05/24。当前值范围 227.79~252.41 万，呈明显上升趋势。从4月底的约228万逐步攀升至5月下旬的约251万。同比对比近几日 current 开始反超 compare，说明今年休眠会员规模增长略高于去年同期。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator dormantMemberNum
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的休眠期会员数排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 919776,
      "yoy": { "value": 0.06654916307681603, "unit": null },
      "mom": { "value": -0.006464951537167801, "unit": null }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 718190,
      "yoy": { "value": 0.06443934597280025, "unit": null },
      "mom": { "value": -0.007274833334024463, "unit": null }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 150386,
      "yoy": { "value": 0.0903382973478532, "unit": null },
      "mom": { "value": 0.0023528157138762804, "unit": null }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 7027,
      "yoy": { "value": 0.05368121157594842, "unit": null },
      "mom": { "value": -0.012784490025288002, "unit": null }
    }
  ]
}
```

> 排序按 current 降序。粤西（91.98万）休眠会员最多，占全国总量的36.6%。华东同比增幅最大（+9.03%），运营直管环比降幅最大（-1.28%）。所有区域同比均为正增长，但环比除华东外均小幅下降。

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
  --indicator dormantMemberNum \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report user indicators \
  --indicator dormantMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report user trend \
  --indicator dormantMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01

# 区域表现（在粤西范围内按督导下钻）
qdm-cmr-cli report user area \
  --indicator dormantMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01
```

### 示例 3：月度汇总 + 华东区域维度

```bash
qdm-cmr-cli report user indicators \
  --indicator dormantMemberNum \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator dormantMemberNum \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 三类数据，适合报告生成场景。

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "down"` 且 `value: 0.0721` 表示箭头向下但数值为正（同比+7.21%，休眠规模扩大为负面信号所以箭头向下）。
3. 休眠期会员数 `threshold` 为 null，无预设阈值。
4. 休眠期会员数 `valueUnit: 1`，值为整数（如 251.27 万），需结合 `zhCNUnit: "万"` 理解量级。同比环比 unit 为 2（比率变化）。
5. 休眠期会员数有子指标 `winbackMemberRate`（用户挽回率），该子指标仅在 CLI 返回有值时展示。
6. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
7. 用户报表不支持品类过滤，与经营分析报表（`report business`）不同。
8. 区域过滤条件在所有子命令（`indicators`/`area`/`trend`/`overview`）中通用。
9. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户报表页面。