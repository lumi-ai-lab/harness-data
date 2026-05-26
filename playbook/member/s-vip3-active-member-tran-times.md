# vip3活跃会员消费频次指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli report user` 获取vip3活跃会员消费频次（`vip3ActiveMemberTranTimes`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code vip3ActiveMemberTranTimes --full
```

返回字段：`indicatorsName`（vip3活跃会员消费频次）、`businessDefinition`（会员等级为vip3的活跃会员，平均每位会员在统计周期内的消费次数）、`statisticalLogic`（统计周期内，vip3活跃会员来客数 / vip3活跃会员消费人数）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator vip3ActiveMemberTranTimes --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **注意**：用户报表不支持品类过滤（无 `--category-type` / `--category` 参数）。

### 返回数据结构

```json
{
  "indicatorCode": "vip3ActiveMemberTranTimes",
  "indicatorName": "vip3活跃会员消费频次",
  "value": 1.893009377664109,
  "valueUnit": 2,
  "mom": {
    "value": -0.0076,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": -0.0183,
    "status": "up",
    "unit": 2
  },
  "threshold": null,
  "zhCNUnit": ""
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如人数）
- `valueUnit: 2` — 百分比/比率/金额（直接用值，如 1.893 表示 1.893 次）
- `valueUnit: 3` — 小数形式的比率（需 ×100 转为百分比，如 0.1478 表示 14.78%）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 `-0.0076` 表示 -0.76%）
- `unit: 3` — 小数形式的比率变化（如 `0.0007` 表示 +0.07 个百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator vip3ActiveMemberTranTimes
```

返回最近约 30 天的逐日数据（current）和同比对照数据（compare）：

```json
{
  "grouping": "ctime",
  "rows": [
    { "period": "2026/04/25", "current": 2.0168533567611098, "compare": 1.9254383382593643 },
    { "period": "2026/04/26", "current": 1.999314629676535, "compare": 2.0151660337627617 },
    { "period": "2026/04/27", "current": 1.8508807160479661, "compare": 1.9536954995799916 },
    { "period": "2026/04/28", "current": 1.8717561482507794, "compare": 1.9098015564653623 },
    { "period": "2026/04/29", "current": 1.877126002899258, "compare": 1.8514723550880692 },
    { "period": "2026/04/30", "current": 1.8848152892501142, "compare": 1.9313786500718046 },
    { "period": "2026/05/01", "current": 2.0622446994748103, "compare": 2.0875902746113226 },
    { "period": "2026/05/02", "current": 2.015324135035591, "compare": 2.0592853145735073 },
    { "period": "2026/05/03", "current": 2.0291913290798678, "compare": 2.0269806755887667 },
    { "period": "2026/05/04", "current": 1.9236542623752007, "compare": 1.9759500098738962 },
    { "period": "2026/05/05", "current": 1.9512119617373, "compare": 1.9196116697950203 },
    { "period": "2026/05/06", "current": 1.8565150855714827, "compare": 1.802502410377772 },
    { "period": "2026/05/07", "current": 1.8677415764725522, "compare": 1.8971210230472761 },
    { "period": "2026/05/08", "current": 1.8839012078601045, "compare": 1.8386495975338242 },
    { "period": "2026/05/09", "current": 1.894020670673482, "compare": 1.8857339359402634 },
    { "period": "2026/05/10", "current": 2.052054754108033, "compare": 1.9835658387206532 },
    { "period": "2026/05/11", "current": 1.8292941971613401, "compare": 1.9792618548673377 },
    { "period": "2026/05/12", "current": 1.8339554945852186, "compare": 1.8263742960410188 },
    { "period": "2026/05/13", "current": 1.8451040326040327, "compare": 1.8120794552560537 },
    { "period": "2026/05/14", "current": 1.8385391702614902, "compare": 1.8436007373384526 },
    { "period": "2026/05/15", "current": 1.847984562607204, "compare": 1.845830754715067 },
    { "period": "2026/05/16", "current": 1.9522241213990912, "compare": 1.8379247918067554 },
    { "period": "2026/05/17", "current": 1.928358630427109, "compare": 1.9602904787520172 },
    { "period": "2026/05/18", "current": 1.799287333132459, "compare": 1.9103267016383554 },
    { "period": "2026/05/19", "current": 1.8178778478437754, "compare": 1.8191853825656643 },
    { "period": "2026/05/20", "current": 1.8759558314205387, "compare": 1.7759874449253323 },
    { "period": "2026/05/21", "current": 1.8059163804457299, "compare": 1.8187367671211192 },
    { "period": "2026/05/22", "current": 1.7825405849283051, "compare": 1.8061788744302665 },
    { "period": "2026/05/23", "current": 1.9075002653082882, "compare": 1.826130744362644 },
    { "period": "2026/05/24", "current": 1.893009377664109, "compare": 1.9213277414075287 }
  ]
}
```

> 近30天趋势范围：2026/04/25 ~ 2026/05/24。当前值范围 1.78~2.06 次，峰值出现在 2026/05/01（current=2.0622），低谷出现在 2026/05/22（current=1.7825）。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator vip3ActiveMemberTranTimes
```

默认按**管理区域**（`manageAreaId`）维度分组，返回全国各区域的vip3活跃会员消费频次排名（含同比、环比）：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN15",
      "name": "华东",
      "current": 2.8395888118575185,
      "yoy": { "value": -0.002345374531634062, "unit": null },
      "mom": { "value": 0.029493344748971237, "unit": null }
    },
    {
      "code": "CN01",
      "name": "粤西",
      "current": 1.8768783325254483,
      "yoy": { "value": -0.025371402647866106, "unit": null },
      "mom": { "value": -0.0281638057394363, "unit": null }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 1.774583255291253,
      "yoy": { "value": -0.006080557558704654, "unit": null },
      "mom": { "value": 0.006821781443864723, "unit": null }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 1.4818652849740932,
      "yoy": { "value": -0.03975129533678759, "unit": null },
      "mom": { "value": -0.10107436757086256, "unit": null }
    }
  ]
}
```

> 排序按 current 降序。华东（2.84次）消费频次最高，远高于其他区域。运营直管（1.48次）最低，环比大幅下降10.11%。所有区域同比均呈下降趋势。

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
  - `督导` → `groupManagerId`（如 Q027115 等督导编码）
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
  --indicator vip3ActiveMemberTranTimes \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report user indicators \
  --indicator vip3ActiveMemberTranTimes \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report user trend \
  --indicator vip3ActiveMemberTranTimes \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01

# 区域表现（在粤西范围内按督导下钻）
qdm-cmr-cli report user area \
  --indicator vip3ActiveMemberTranTimes \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01
```

### 示例 3：月度汇总 + 华东区域维度

```bash
qdm-cmr-cli report user indicators \
  --indicator vip3ActiveMemberTranTimes \
  --month 2026-05 \
  --area-type 管理区域 --area CN15 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator vip3ActiveMemberTranTimes \
  --date 2026-05-24
```

`overview` 子命令一次性返回 `indicators`、`area`、`trend` 三类数据，适合报告生成场景。

---

## 七、注意事项

1. **同比（yoy）** = 与去年同期对比的变化率；**环比（mom）** = 与上一个周期对比的变化率。
2. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。`status: "up"` 且 `value: -0.0076` 表示箭头向上但数值为 -0.76%（即环比下降）。
3. vip3活跃会员消费频次 `threshold` 为 null，无预设阈值。
4. vip3活跃会员消费频次 `valueUnit: 2`，值为比率（如 1.893 表示平均消费 1.893 次），同比环比 unit 为 2（比率变化）。
5. 如果指定了 `--area-type` 但未指定 `--area`（或反之），CLI 会报错。
6. 用户报表不支持品类过滤，与经营分析报表（`report business`）不同。
7. 区域过滤条件在所有子命令（`indicators`/`area`/`trend`/`overview`）中通用。
8. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户报表页面。
9. vip3活跃会员消费频次为叶子指标，无下钻子指标，在报告中不需要展示父子链路表格。