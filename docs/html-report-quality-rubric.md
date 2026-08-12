# html-report 报告质量母表与分阶段清单

更新时间：2026-07-31（Asia/Shanghai）

> **权威词典**：R1–R7 中文名与好坏标准。  
> **过程门**只跑本阶段短清单；**全量 0–2 打分仅 B4 Report Reviewer 评委**。  
> Report Editor / Researcher 自查 / Report Reviewer 评委共用本母表语言。

完整流水线见 `docs/html-report-pipeline.md`；Report Editor 操作见 `.agents/pi/skills/html-report/SKILL.md`。

---

## 1. 下钻闭环（有问题的部分要不要下钻？）

**要。** 质量标准不仅用于「打分」，更用于 **定位薄弱点 → Report Editor 建 Researcher task → 先判定复用证据还是确需新查**。

| 何时发现「有问题」 | 谁发现 | 下一步 |
| --- | --- | --- |
| 入门卡答不全题 / 缺维 / 缺指标 | Report Editor B2.5 对照题面与 R1/R3/R4/R5 | 写入 `editorial.gaps`，建 task 并选择 `reuse_entry` / `new_query` |
| 某项 Researcher 结果仍浅 / 同构 / 只贴表 | Report Editor B3.5 清单 + Researcher 自查 | 先修正 evidence plan；真实数据缺口才升级 `new_query`（不重跑 Writer） |
| 终审某维失分（如 R4 低） | Report Reviewer 评委 scores | Report Editor 按失分项回 B3.5 建对应 Researcher task（轮次允许） |
| CLI 技术失败 | B2 typed/meta failed | 当前 attempt 确定性 fail；不自动重试，修复后仅由用户显式重试当前 Gate |

**禁止**：因「分析浅」重复 spawn 同一 report-writer（只会重跑 HTML 确认 CLI，几乎不提质）。

```text
发现问题（缺口 / 失分 / 自查否）
  → Report Editor 写成可执行 Researcher task 并选择 mode
  → reuse_entry：固定脚本生成 evidence，Researcher 只分析
  → new_query：仅真实证据缺口时定向取数，再生成 evidence 并分析
  → 合并 main →（必要时再一轮）→ B4 全量评分
```

---

## 2. 母表 R1–R7（共用词典）

编号便于引用；文档与 verdict 中写 **「R1 题面回答」** 这种中文名+编号。

| 编号 | 中文名 | 在问什么 | 0 分（差） | 1 分（及格） | 2 分（好） |
| --- | --- | --- | --- | --- | --- |
| **R1** | **题面回答** | 是否直接回答用户原问题 | 只堆表、不答题 | 部分回答 | 结论对准题面关键词，缺口有说明 |
| **R2** | **证据与全量表** | 数字可追溯？表是否全量？ | 无表/漏行/编数 | 有表但来源含糊 | 全量明细表；关键数可指到 data |
| **R3** | **维度/结构深度** | 是否按题完成结构拆解 | 只有机械复述且未回答结构问题 | 用已有明细做初步结构拆解，或说明无需换维 | 按题完成有意义的结构拆解；确有需要时才实质换维 |
| **R4** | **指标丰富度** | 现有指标是否足够；是否按需扩展 | 题面确需新增指标却未补充或说明 | 对现有指标是否足够有合理说明 | 按需新增指标，或充分证明现有指标已足够/Spec 无合法扩展 |
| **R5** | **对比与拆解** | 是否对比/构成/驱动 | 只复述极值涨跌 | 简单对比 | 有对照链条且有数 |
| **R6** | **一致性** | 章节与 main 是否矛盾 | 明显打架 | 小出入 | 叙事与 summary 一致 |
| **R7** | **范围忠实** | 是否偏离确认范围 | 偷换题 | 略扩但说明 | 不跑题；探索扩展有理由 |

### 2.1 终审计分（仅 B4）

- 每项 **0 / 1 / 2**；**满分 14**。  
- **真 hard 一票否决**：无法从 **行级 data** 或 **指标列 sum/avg/min/max** 复算的关键数，或 **编造/模拟业务列**（`INVENTED_METRIC`）→ `pass=false`。  
- 报告中的「列合计」若等于 data 列 sum → scan 应匹配，**不**因 hard 否决。  
- **禁止**用 A×B 自造未取业务列（如模拟销售额）；需要则 Researcher **真取数**。  
- **基础 pass 公式**：无真 hardBlockers / hard issues，且 **total ≥ 10**，且
  **R1 ≥ 1**，且 **R2 ≥ 1**。当没有动态任务目标时，这仍是完整且唯一的放行公式。
- **动态任务门禁**：只汇总当前 Session `analysis/tasks.json` 中 `status=done` 的
  Researcher tasks。新结构读取每个 `analysisRequirements[].targetRubric` 及其
  `minScore`（只能是 1 或 2，缺省为 2）；兼容旧 `task.targetRubric`，其默认门槛为
  2。同一 rubric 被多项要求引用时取最高最低分。任一目标实际得分低于门槛，均令
  `pass=false`，即使基础公式已经满足。
- `write-verdict.mjs` 确定性重算基础公式与动态门禁；Reviewer 应按报告证据如实打分，
  不能为满足 task 目标主观抬分，也不能自行删除或伪造目标。
- B4 fail 后由 **Report Editor** 有限次自修复（`quality/repair-log.json`），再 Review，合格后 Designer 出 HTML。

---

## 3. 分阶段清单（侧重点，不做全量打分）

### 3.1 B2 · report-writer 收工（侧重 R2）

| 必检 | 通过 | 失败处置 |
| --- | --- | --- |
| 路径 | entry.json + entry.meta.json + Writer 结构化返回路径 | 技术缺失 → 有限重试 Writer；已有合法产物则自动复用 |
| 取数 | ok 或清晰 failed | CLI 技术失败 → fail 当前 Gate；同一 attempt 不重派 report-writer |
| 数据明细 | 成功卡 entry/meta 完整，且 rowCount 与 rowsSha256 符合 CLI `--meta` 契约 | 缺失或行数/哈希格式不符 → fail 当前 Gate；用户批准新 attempt 后才可重跑，**浅分析不重跑 Writer** |
| deeper 线索 | 题答不全不宜无理由空 | 空则Report Editor B2.5 自建 tasks |

### 3.2 B2.5 · Report Editor规划（侧重 R1 缺口 + R3/R4/R5 派工）

| 必检 | 通过 |
| --- | --- |
| 缺口 | `editorial.gaps` 或 main「待加深」对照用户问题 |
| 任务覆盖 | 先判断 Writer entry 是否覆盖；排序、TopN、分组、区间和已有行比较用 `reuse_entry`，缺指标/维度/粒度/范围/对象/对照/口径才用 `new_query`；同源缺口应合并，跨类别用 `evidenceGap.types[]` |
| 可执行 | goal/gap/evidencePlan 清楚；operations 使用固定脚本白名单；禁止与 analysisFocus 同义反复 |
| 质量目标 | capability/operation 决定最低 rubric：comparison/association 至少 R5；基础 stats/range distribution 不自动强制 R3/R5；structural_breakdown 与 joint_tradeoff 至少 R3+R5；补指标/口径型 new_query 至少 R4。同一结构 view 上只解释完整性边界的 data_quality requirement 不重复继承结构分析 requirement 的 R3/R5。平衡/权衡类问题必须使用 joint_tradeoff + jointQuantileBins，不能由 Planner 降级 capability 或漏报来绕过终审 |
| main 初稿 | 紧凑保留题面、范围、一个已验收且带 `entry.json#...` 证据的 Writer finding 和待加深位置；不出现 Markdown 表格、不复制明细行/样例表，也不预写研究结论 |

**本关禁止**：R1–R7 全量打分；跑 quality-scan。

### 3.3 B3.5 · Researcher 收工（侧重 R3/R4/R5 + 推进 R1）

**Researcher 自查**（是/否 + 一句，写入 `selfCheck`，**不是**终审分）：

| 项 | 对应母表 |
| --- | --- |
| mode 合规：reuse 未查数；new_query 有 material delta | R3 / R4 |
| evidence producer、源行数/Hash 与引用可追溯 | R2 / R6 |
| 对比/拆解而不只贴表 | R5 |
| 联合分箱先验 support：低于通用 cell 最小样本门槛的原始赢家必须降级；只把支持度合格 cell 作为标注清楚的替代候选，不声称稳健/全局最优 | R3 / R5 / R6 |
| 直接回答本 task goal | R1 子问题 |
| 全量表由 assemble 从 Writer/explore JSON 确定性插入 | R2 |

`reuse_entry` 不要求换维或扩指标；现有证据足以回答时，强行新查反而不合规。
**Report Editor**：evidence/paths 齐 + 抽查自查 + 是否推进 gaps；不通过 → 修正 evidence plan，真实数据缺口才升级 `new_query`。

### 3.4 B4 · Report Reviewer 评委（唯一全量 R1–R7）

1. 父扩展对最终 `report/report.md` 运行 `quality-scan.mjs`；hard>0 写 repair-log、fail Gate 且不派 Reviewer，hard=0 才冻结五输入
2. Reviewer 在固定模型/150 秒/4+1 turns/六次工具预算内，禁止 Bash 与重复 scan；五输入各读一次
3. 逐项 typed scores/notes + issues + repairHints，调用一次 `submit_review_scorecard`
4. 工具确定性计算 total/pass 与 done-task 动态门禁，安全序列化 draft/verdict，并生成 report.md 评分表；父扩展唯一运行 `--phase quality`
5. fail → Report Editor 按失分项建立 Researcher task（见 §1），写 repair-log 并等待用户“重试当前阶段”

---

## 4. tasks 与 targetRubric

`tasks.json` 由 **Report Editor** 写给 **Report Researcher**。
`targetRubric` 表示本任务主要想改善哪几维；不能为了提分强行新查，mode 仍由真实证据覆盖决定。

动态门禁只认结构化声明，不按测试 Prompt、指标名或业务字段特判：

- 新 B2.5 Planner task 以 `analysisRequirements[].targetRubric` 为主；Planner
  不暴露 `minScore`，每项固定省略并由下游按 2 验收。下游仍兼容既有或外部 task
  中显式的 `minScore: 1|2`。
- 顶层 `task.targetRubric` 用于兼容旧 task，也可补充本 task requirements 尚未覆盖的
  rubric，默认门槛为 2。
- `pending`、`failed` 等非 `done` task 不进入终审门禁。
- `quality/verdict.json` 和 Reviewer 正常结构化返回始终包含
  `requiredRubrics` 与 `gateFailures`。前者记录最终目标、门槛及 task/requirement
  来源；后者记录实际得分低于门槛的项目。两者用于审计，不能由模型手写。
- `analysis/tasks.json` 不存在时按无动态目标处理，以兼容旧 Session；文件存在但 JSON
  或门禁字段非法时必须失败，不能静默放行。

report-writer 的 `suggestedDeeper` 只是给Report Editor的 **线索**，不是正式派工单。
