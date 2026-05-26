# 可触达用户数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli report user` 获取可触达用户数（`reachMemberNum`）指标的值、趋势数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code reachMemberNum --full
```

返回字段：`indicatorsName`（可触达用户数）、`businessDefinition`（各渠道（小程序、社群、微信公众号、抖音）可触达的用户数量）、`statisticalLogic`（各渠道可触达的用户数量）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator reachMemberNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **注意**：用户报表不支持品类过滤（无 `--category-type` / `--category` 参数）。

### 返回数据结构

```json
{
  "indicatorCode": "reachMemberNum",
  "indicatorName": "可触达用户数",
  "value": 3045.08,
  "valueUnit": 1,
  "zhCNUnit": "万",
  "mom": {
    "value": 0.0005,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.0026,
    "status": "up",
    "unit": 2
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如 3045.08 万即 30,450,800 人）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1478 表示 14.78%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 `0.0005` 表示 +0.05%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator reachMemberNum
```

返回最近约 30 天的逐日数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/04/25", "current": 3022.8877, "compare": 2681.6072, "unit": "万" },
    { "period": "2026/04/26", "current": 3023.6263, "compare": 2682.6843, "unit": "万" },
    { "period": "2026/04/27", "current": 3023.9266, "compare": 2683.5486, "unit": "万" },
    { "period": "2026/04/28", "current": 3025.2421, "compare": 2684.3205, "unit": "万" },
    { "period": "2026/04/29", "current": 3025.7032, "compare": 2686.1147, "unit": "万" },
    { "period": "2026/04/30", "current": 3026.2183, "compare": 2686.8698, "unit": "万" },
    { "period": "2026/05/01", "current": 3026.8887, "compare": 2687.843, "unit": "万" },
    { "period": "2026/05/02", "current": 3027.5695, "compare": 2688.677, "unit": "万" },
    { "period": "2026/05/03", "current": 3027.5259, "compare": 2689.5349, "unit": "万" },
    { "period": "2026/05/04", "current": 3028.0159, "compare": 2690.3977, "unit": "万" },
    { "period": "2026/05/05", "current": 3029.7441, "compare": 2691.2884, "unit": "万" },
    { "period": "2026/05/06", "current": 3030.1682, "compare": 2693.1004, "unit": "万" },
    { "period": "2026/05/07", "current": 3030.8092, "compare": 2693.9313, "unit": "万" },
    { "period": "2026/05/08", "current": 3031.3146, "compare": 2694.8562, "unit": "万" },
    { "period": "2026/05/09", "current": 3031.7832, "compare": 2695.7851, "unit": "万" },
    { "period": "2026/05/10", "current": 3032.4853, "compare": 2696.8712, "unit": "万" },
    { "period": "2026/05/11", "current": 3032.8555, "compare": 2698.0861, "unit": "万" },
    { "period": "2026/05/12", "current": 3034.157, "compare": 2698.8828, "unit": "万" },
    { "period": "2026/05/13", "current": 3034.7352, "compare": 2700.7915, "unit": "万" },
    { "period": "2026/05/14", "current": 3035.2961, "compare": 2701.6802, "unit": "万" },
    { "period": "2026/05/15", "current": 3035.7278, "compare": 2702.4817, "unit": "万" },
    { "period": "2026/05/16", "current": 3036.5009, "compare": 2703.2516, "unit": "万" },
    { "period": "2026/05/17", "current": 3037.1791, "compare": 2704.3042, "unit": "万" },
    { "period": "2026/05/18", "current": 3037.6616, "compare": 2705.3301, "unit": "万" },
    { "period": "2026/05/19", "current": 3039.0533, "compare": 2706.185, "unit": "万" },
    { "period": "2026/05/20", "current": 3039.7983, "compare": 2708.0536, "unit": "万" },
    { "period": "2026/05/21", "current": 3040.8563, "compare": 2708.818, "unit": "万" },
    { "period": "2026/05/22", "current": 3042.0301, "compare": 2709.5871, "unit": "万" },
    { "period": "2026/05/23", "current": 3043.5197, "compare": 2710.3522, "unit": "万" },
    { "period": "2026/05/24", "current": 3045.0766, "compare": 2711.4802, "unit": "万" }
  ]
}
```

> 近30天趋势范围：2026/04/25 ~ 2026/05/24。可触达用户数呈稳步增长趋势，从4月底的约3023万持续攀升至5月24日的3045万，日均增长约0.75万。同比对比远低于当前值（约2681~2711万 vs 3023~3045万），说明今年可触达用户规模大幅高于去年同期（同比增长约12%）。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator reachMemberNum
```

默认按**管理区域**（`manageAreaId`）维度分组。

> 当前（2026-05-24）区域表现无数据（rows 为空数组），说明该指标暂无区域维度的有效数据。

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
  --indicator reachMemberNum \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 趋势

```bash
# 指标值
qdm-cmr-cli report user indicators \
  --indicator reachMemberNum \
  --date 2026-05-24 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report user trend \
  --indicator reachMemberNum \
  --date 2026-05-24
```

### 示例 3：月度汇总 + 全国维度

```bash
qdm-cmr-cli report user indicators \
  --indicator reachMemberNum \
  --month 2026-05 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator reachMemberNum \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 三类数据，适合报告生成场景。

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: 0.0005` 表示箭头向上、数值+0.05%（即环比微增）。
3. 可触达用户数 `threshold` 为 null，无预设阈值。
4. 可触达用户数 `valueUnit: 1`，值为整数（如 3045.08 万），需结合 `zhCNUnit: "万"` 理解量级。同比环比 unit 为 2（比率变化）。
5. 可触达用户数有子指标：`memberNum`（会员数）、`communityUserNum`（社群用户数）、官媒用户数、抖音用户数，构成渠道触达拆解链路。
6. 可触达用户数跨维度归属：第三章（用户规模与分层结构）和第五章（用户触达与渠道效率）。
7. 区域数据当前为 null（rows 为空），如需区域分析需以 CLI 实际返回为准。
8. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
9. 用户报表不支持品类过滤，与经营分析报表（`report business`）不同。
10. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户报表页面。