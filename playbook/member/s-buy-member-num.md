# 消费会员数指标取数手册 (Playbook)

> 本手册讲解如何通过 `qdm-cmr-cli` 获取消费会员数（`buyMemberNum`）指标的值、趋势和区域表现数据，以及如何添加过滤条件。用户报表使用 `report user` 子命令。

## 一、获取指标详情

```bash
qdm-cmr-cli indicator detail --code buyMemberNum --full
```

返回字段：`indicatorsName`（消费会员数）、`businessDefinition`（当日发生消费行为的会员人数）、`statisticalLogic`（按销售小票标识的会员ID去重计数）、`indicatorBiz`（销售经营）。

---

## 二、获取指标值（含同比、环比）

### 基础命令（默认：全国、昨天）

```bash
qdm-cmr-cli report user indicators --indicator buyMemberNum --display-mode yoyMom
```

- **默认时间**：昨天（无需指定 `--date`，CLI 自动取昨天日期）。
- **默认区域**：全国（不含港澳），`areaId: CN00`，`storeTypeName: 管理区域`。
- **用户报表不支持品类过滤**，不传 `--category-type` 和 `--category`。

### 返回数据结构

```json
{
  "indicatorCode": "buyMemberNum",
  "indicatorName": "消费会员数",
  "value": 948937,
  "valueUnit": 1,
  "zhCNUnit": "",
  "mom": {
    "value": 0.0123,
    "status": "up",
    "unit": 2
  },
  "yoy": {
    "value": 0.0178,
    "status": "up",
    "unit": 2
  },
  "threshold": null
}
```

**value 的含义取决于 valueUnit**：
- `valueUnit: 1` — 整数值（如消费会员数，值为人）
- `valueUnit: 2` — 百分比/比率/金额（直接用值）
- `valueUnit: 3` — 小数形式的比率（需 x100 转为百分比）

**同比/环比的 value**：
- `unit: 1` — 绝对变化量
- `unit: 2` — 比率变化（如 `0.0123` 表示 +1.23%）
- `unit: 3` — 小数形式的比率变化（百分点）

---

## 三、获取趋势分析数据

```bash
qdm-cmr-cli report user trend --indicator buyMemberNum
```

返回最近约 30 天的逐日消费会员数数据（current）和同比对照数据（compare）：

```json
{
  "rows": [
    {
      "period": "2026/04/25",
      "current": 947240,
      "compare": 834163
    },
    {
      "period": "2026/04/26",
      "current": 945917,
      "compare": 929818
    },
    {
      "period": "2026/04/27",
      "current": 863396,
      "compare": 868091
    },
    {
      "period": "2026/04/28",
      "current": 871764,
      "compare": 836898
    },
    {
      "period": "2026/04/29",
      "current": 856288,
      "compare": 849776
    },
    {
      "period": "2026/05/19",
      "current": 851318,
      "compare": 889482
    },
    {
      "period": "2026/05/20",
      "current": 825717,
      "compare": 879012
    },
    {
      "period": "2026/05/21",
      "current": 875241,
      "compare": 853088
    },
    {
      "period": "2026/05/22",
      "current": 890879,
      "compare": 857037
    },
    {
      "period": "2026/05/23",
      "current": 937381,
      "compare": 820225
    },
    {
      "period": "2026/05/24",
      "current": 948937,
      "compare": 930875
    }
  ]
}
```

> 近30天趋势范围：2026/04/25 ~ 2026/05/24。范围 825,717~955,682。呈现明显周期性：周末（周五~周日）90万+，工作日（周一~周四）85万左右。05/20 为低点（825,717），05/24 为近期高点（948,937）。

可使用 `--month YYYY-MM` 获取月度趋势，`--week YYYY-NN` 获取周度趋势。

---

## 四、获取区域表现数据

```bash
qdm-cmr-cli report user area --indicator buyMemberNum
```

默认按**管理区域**（`manageAreaId`）维度分组：

```json
{
  "grouping": "storeId",
  "rows": [
    {
      "code": "CN01",
      "name": "粤西",
      "current": 335378,
      "mom": { "value": 0.019764167867719944 },
      "yoy": { "value": 0.026151130094758453 }
    },
    {
      "code": "CN18",
      "name": "粤东",
      "current": 292150,
      "mom": { "value": 0.006736849359913162 },
      "yoy": { "value": 0.0029558273741885207 }
    },
    {
      "code": "CN15",
      "name": "华东",
      "current": 46662,
      "mom": { "value": -0.042359315355251816 },
      "yoy": { "value": -0.048956465025273115 }
    },
    {
      "code": "CN07",
      "name": "运营直管",
      "current": 2495,
      "mom": { "value": -0.00040064102564102563 },
      "yoy": { "value": 0.3243099787685775 }
    }
  ]
}
```

> 排序按 current 降序。粤西（335,378）和粤东（292,150）贡献了主要消费会员。华东环比同比双降（-4.24%/-4.90%）。运营直管同比增速最高（+32.43%）但体量极小。

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

### 5.3 品类过滤

**用户报表不支持品类过滤**。不要传递 `--category-type` 或 `--category` 参数。

### 5.4 显示模式

| 参数 | 说明 |
| :--- | :--- |
| `--display-mode yoyMom` | 返回同比（yoy）和环比（mom）数据 |

---

## 六、完整示例

### 示例 1：默认查询（全国、昨天、含同比环比）

```bash
qdm-cmr-cli report user indicators \
  --indicator buyMemberNum \
  --display-mode yoyMom
```

### 示例 2：指定日期 + 粤西区域 + 趋势

```bash
# 指标值
qdm-cmr-cli report user indicators \
  --indicator buyMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01 \
  --display-mode yoyMom

# 趋势
qdm-cmr-cli report user trend \
  --indicator buyMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01

# 区域表现（在粤西范围内按督导下钻）
qdm-cmr-cli report user area \
  --indicator buyMemberNum \
  --date 2026-05-24 \
  --area-type 管理区域 --area CN01
```

### 示例 3：月度汇总 + 督导区域维度

```bash
qdm-cmr-cli report user indicators \
  --indicator buyMemberNum \
  --month 2026-05 \
  --area-type 督导 --area Q027115 \
  --display-mode yoyMom
```

### 示例 4：一次性获取全量数据（overview）

```bash
qdm-cmr-cli report user overview \
  --indicator buyMemberNum \
  --date 2026-05-24
```

---

## 七、注意事项

1. 同比/环比中的 `status` 字段（`up`/`down`）表示箭头指向，不代表数值正负。
2. 消费会员数 `threshold` 为 null，无预设阈值。
3. 消费会员数 `valueUnit: 1`，值为整数（如 948,937），同比环比 unit 为 2（比率变化）。
4. 用户报表**不支持品类过滤**，不要传递 `--category-type` 或 `--category` 参数。
5. 消费会员数是叶子指标，无下级子指标，不支持下钻分析。
6. 父指标为会员复购率（`memberRepurchaseNoDifferenceRate`），消费会员数作为分母参与计算。
7. 所有数据均来自 `qdm-cmr-cli report user`，报告 `/report/3` 对应用户运营分析页面。