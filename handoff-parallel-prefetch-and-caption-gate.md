# Handoff：B2 并行预取取数 + caption 门禁规则简化

更新时间：2026-08-15
工作区：`/Users/pengmd/c/qdm/harenss-data-feat-skill-html-report`
分支：`feat-skill-html-report`
提交：`446d4fe` feat(html-report): B2并行预取取数 + caption门禁规则简化
接手自：`handoff-zh-column-labels.md`（字段列中文映射 + 维度值中文展示）

> **当前状态（先看这个）**
>
> 1. B2 并行预取已实现：14 张卡的 CLI 取数从串行改为并行（并发 6），预取完成后 Writer 走缓存命中。
> 2. caption 门禁数字校验从三种检查（精确/四舍五入/截断）简化为整数部分一致即放行。
> 3. evidence 数值在 evidence builder 里四舍五入到 2 位小数（用 `roundHalfUpUnsigned` 避免 IEEE-754）。
> 4. 新增缩写 MM-DD 日期剥离（如 `2026-08-01 至 08-10` 中的 `08-10`）。
> 5. 所有 caption 规则加了中文注释。
> 6. **未验证**：3 次 B2 端到端测试均因不同 caption 门禁问题失败（已全部修复），尚未重跑完整 14 卡测试。
> 7. B2 测试超时需 ≥ 18min（14 卡实测约 11min，含 40% 缓冲）。

---

## 1. 起因

### 1.1 从哪接过来

上一份 handoff（`handoff-zh-column-labels.md`）记录了字段列中文映射的改造。改造完成后，需要重跑 14 卡 B2 端到端测试验证。但 14 张卡串行取数 + 串行 Writer 派发，每卡 ~45s，总耗时 ~10min，接近超时上限。

用户提出：**能否把 Card 的 Query 改成并行以加快速度？**

### 1.2 最初的问题

```
当前流程（全串行）
═════════════════════════════════════════════════════════════

扩展(qdm-harness)
  │
  ├──NEXT_TOOL_ONLY: status
  ├──NEXT_TOOL_ONLY: Writer(card1)
  │     └─► ack_cli_data → fetchAllEntries(--card-id 1)
  │           └─► runMetricQuery (spawnSync, 阻塞 ~15s)
  │     └─► LLM 写 caption ~22s
  │     └─► submit_card_caption (质量门)
  │
  ├──NEXT_TOOL_ONLY: Writer(card2)  ← 等 card1 完成才派
  │     ... 重复 14 次

总计: 14 × (CLI 15s + LLM 22s + 开销 3s) = ~10min
```

瓶颈在两层：
- **扩展层**：`unsupportedParallelReportAgent` 硬编码禁止 `tasks[]` 和 `chain[].parallel[]`，一次只派一个 Writer
- **脚本层**：`runMetricQuery` 用 `spawnSync`（同步阻塞），单进程内无法并行

---

## 2. 做了哪些分析

### 2.1 三个方案对比

```
方案A(现状全串行)        方案B(批量预取)          方案C(流水线)
CLI 串行每卡等           CLI 并行, 等全部取完     CLI 后台并行, 不阻塞
Writer 串行              Writer 串行(缓存命中)    Writer 串行(缓存命中)
质量门 逐卡               质量门 逐卡               质量门 逐卡
~10min                   ~6.6min                  ~6min
─                        简单, 无并发竞争          需去重锁防重复取
```

用户选择**方案B**：够简单直接，用时差不多，质量门不变。

### 2.2 失败处理分析

最初设计是"预取失败不阻塞，Writer 自己补取"。用户指出设计缺陷：

```
原方案: 预取失败的卡 → Writer 的 ack_cli_data 自己补取
问题:
  预取已经试过 (3次重试) → 失败
  Writer 再试同样的 query → 大概率也失败
  ↑ 白白浪费一个 Writer 派发周期 (~40s)
```

修正为：**预取即取数，失败即停**。预取用完整重试逻辑（MAX_ATTEMPTS=3），任何卡失败 → `fail B2_WRITER` 立即，不派任何 Writer。

但实际实现时发现：测试环境没有真实 CLI/auth，预取全部失败会导致 B2 立即失败，阻断测试。最终采用分级策略：

```
预取结果
  ├─ 全部成功 → 派 Writer (全缓存命中)
  ├─ 部分失败 (有成功有失败) → fail B2 立即 (真数据错误)
  └─ 全部失败 → 跳过预取, 继续派 Writer (基础设施问题, 降级为现状)
```

### 2.3 caption 门禁问题分析（B2 测试中发现）

3 次 B2 端到端测试，每次都遇到不同的 caption 门禁问题：

#### 问题 1：截断小数被拒（第 2 轮测试）

```
evidence: 2199.295 (3位小数)
Writer:   2199.29  (截断 — 直接砍末位 5)
验证器:    roundHalfUp("2199.295", 2) = "2199.30" ≠ "2199.29" → ❌
```

验证器只接受精确值和四舍五入值，不接受截断。Writer LLM 经常截断而非正确四舍五入。

**修复**：新增 `truncUnsigned` 函数，`evidenceAllowsCaptionNumber` 同时检查 `roundHalfUp` 和 `truncUnsigned`。

#### 问题 2：缩写日期被当数字（第 3 轮测试）

```
原文: "2026-08-01 至 08-10 期间，香港区..."
DATE_TOKEN 剥离: "2026-08-01" → 移除
剩余: " 至 08-10 期间，香港区..."
NUMBER_TOKEN 提取: ["08", "10"]
校验 "08" → evidence 里没有 → ❌
```

`DATE_TOKEN` 只认完整 ISO 日期（`\d{4}-\d{2}-\d{2}`），缩写 `08-10` 没被剥离。

**修复**：新增 `ABBREVIATED_DATE_TOKEN = /(?<!\d)\d{1,2}-\d{1,2}(?!\d)/g`，在 ISO 和中文日期剥离后追加一步。

#### 问题 3：转录误差被拒（第 4 轮测试）

```
evidence: 4464.3966 (4位小数)
Writer:   4464.3968 (末位 6→8, 抄错了)
验证器:    精确/四舍五入/截断 全部不匹配 → ❌
```

这不是截断也不是四舍五入，是 LLM 转录高精度数字时的末位错误。旁边有 `14005.7968`（以 7968 结尾）干扰，LLM 混淆了末尾。

**修复（两步）**：
1. evidence builder 把 `|value| ≥ 1` 的数值四舍五入到 2 位小数，LLM 只需抄 2 位而非 4 位
2. 数字校验简化为**整数部分一致即放行**（用户最终决定，覆盖截断/四舍五入/转录误差所有场景）

---

## 3. 结论

### 3.1 已落地（代码在 commit `446d4fe`）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `metric-cli-executor.mjs` | 新增 `runMetricQueryAsync`（`child_process.spawn` 异步，返回 Promise，不阻塞事件循环） |
| 2 | `fetch-entry.mjs` | `fetchCard` 加 `queryFn`/`sleepFn` 参数；`fetchAllEntries` 加 `parallel`+`concurrency` 选项（`Promise.all` + worker pool）；CLI 加 `--parallel` flag；新增 `asyncSleep` + `parallelLimit` 辅助函数 |
| 3 | `qdm-harness/index.ts` | B2 status 通过后插入并行预取（`fetchAllEntries` parallel）；部分失败 → `failB2StartupStatus` 立即；全部失败 → 跳过继续派 Writer |
| 4 | `qdm-harness/index.ts` | `remaining` 检查加 `caption.md` 存在性（`lstat` + `captionPathFor`），防预取后 entry 全有但 caption 缺失导致误跳 layout |
| 5 | `writer-return.mjs` | 导出 `captionPathFor(dataPath)` 辅助函数 |
| 6 | `submit-card-caption.mjs` | 数字校验简化为整数部分一致即放行；新增 `ABBREVIATED_DATE_TOKEN` 剥离缩写 MM-DD 日期；所有规则加中文注释 |
| 7 | `prepare-card-caption-evidence.mjs` | evidence 数值四舍五入到 2 位小数（用 `roundHalfUpUnsigned` 避免 IEEE-754 问题）；`|value| < 1` 的小数（率字段）保持原样 |
| 8 | `setup-b2-test.mjs` | 输出超时提醒（根据卡数自动估算，14 卡建议 ≥ 18min） |
| 9 | `caption-evidence.test.mjs` | 更新为整数部分规则；新增缩写日期剥离测试；新增数值取整测试 |
| 10 | `fetch-entry.test.mjs` | 新增并行预取测试 + `captionPathFor` 测试 |
| 11 | `metric-cli-executor.test.mjs` | 新增 `runMetricQueryAsync` 测试（成功 + 非零退出） |

### 3.2 门禁规则总览（简化后）

```
抠除规则（extractCaptionTokens，提取数字前先抠掉不该检查的内容）
  ① 完整 ISO 日期    2026-08-01        → 加入 dates[]，校验 query.time
  ② 中文日期         2026年8月1日       → 只抠不校验
  ③ 缩写 MM-DD 日期  08-10             → 只抠不校验
  ④ 中文专名         19点前客数         → 只抠，防 "19" 被提取
  ⑤ 千分位           4,484,026         → 去逗号 → 4484026
  ⑥ 数据数字         剩余的独立数字      → 提取出来校验

允许集（addAllowedNumber，evidence 数值加入允许集的变形）
  ① 精确值     4464.4（evidence builder 已取整到 2 位）
  ② 绝对值     -0.82 → 也允许 0.82
  ③ 率×100     profitLostRate=-0.0082 → 也允许 0.82
  ④ 万         4484026 → 也允许 448.4026
  ⑤ 亿         4484026 → 也允许 0.04484026

数字匹配（evidenceAllowsCaptionNumber，caption 数字 vs 允许集）
  ① 精确匹配    "4464.4" == "4464.4"           → ✅
  ② 整数一致    整数 4464 == 4464               → ✅
  完全不同的整数  整数 5000 ≠ 4464             → ❌ 拒绝

evidence 取整（roundCaptionValue，在 evidence builder 里）
  |value| ≥ 1 → roundHalfUpUnsigned(String(abs), 2) → 4464.3966 → 4464.4
  |value| < 1 → 保持原样 → -0.0082 不变（率字段保持精度）
  用 digit 字符串半入，不用 Number.toFixed（避免 IEEE-754: 26494489.185→26494489.18 问题）
```

### 3.3 耗时对比

```
方案A(现状全串行)        方案B(并行预取)
CLI 串行 14×15s=210s     CLI 并行 ~60s (并发6, 3轮)
LLM 串行 14×22s=308s     LLM 串行 14×22s=308s (缓存命中省 CLI)
开销 14×3s=42s            开销 ~45s (预取+启动+compose)
─────────────────────────────────────────────
总计 ~560s (~10min)       总计 ~410s (~6.6min)
                          省 ~34%（CLI 中等耗时基准）
```

### 3.4 测试结果

```
529 tests, 519 pass, 10 fail
10 个失败全部是预先存在的（git stash 验证）:
  4 个 B2.5 (handoff-zh-column-labels.md §4.2)
  5 个 html-report (html confirm / server)
  1 个 B5 dynamic e2e
零新增回归
```

---

## 4. 当前要处理的问题

### 4.1 未重跑完整 14 卡 B2 端到端

3 次 B2 测试分别因不同 caption 门禁问题失败（截断/缩写日期/转录误差），已全部修复并简化为整数部分规则。但尚未用修复后的代码重跑完整 14 卡测试。

```bash
# 重跑命令（超时至少 18min = 1080000ms）
cd /Users/pengmd/c/qdm/harenss-data-feat-skill-html-report
node .agents/pi/skills/html-report/scripts/setup-b2-test.mjs \
  --result /Users/pengmd/c/qdm/harenss-data-feat-skill-html-report/result.json
# 终端超时设 ≥ 1080000ms
pisub --session-id test-b2 --approve --print \
  "/skill:html-report 生成运营中心管理周例会报告，分析各区域经营表现"
```

通过标准：Gate `B2_MAIN` + `awaiting_approval`；14 张卡都有 `caption.md`。

### 4.2 B2.5 扩展门测试预先失败（与本次改动无关）

4 个 `extension-gate.test.mjs` 的 B2.5 测试在本次改动之前就已失败（`bridge.requests.length === 2` 断言 `0 !== 2`）。不在本次范围内。

### 4.3 整数部分规则的宽松性

整数部分一致即放行意味着：
- `14.89` 会被接受（evidence 有 `14.48`，整数部分都是 `14`）
- `4464.99` 会被接受（evidence 有 `4464.4`，整数部分都是 `4464`）

这是用户明确要求的设计——优先不阻断 Writer，容忍小数位差异。完全不同的整数（如 `5000` vs `4464`）仍被拒绝。如果后续发现这个规则太松导致错误数据混入报告，可以考虑收紧为"整数一致 + 小数位差 ≤ 1"或恢复四舍五入/截断检查。

---

## 5. 不要再走的弯路

- 不要用 `Number.toFixed` 做四舍五入——IEEE-754 浮点会导致 `26494489.185 → "26494489.18"`（应该 `26494489.19`）。用 `roundHalfUpUnsigned`（digit 字符串运算）。
- 不要在 evidence builder 里给 `|value| < 1` 的数取整——率字段（如 `-0.0082`）保持原样，`addAllowedNumber` 会 ×100 变成 `0.82`，2 位小数够用。
- 不要在方案B 里尝试流水线（方案C）——方案B 预取完成后才派 Writer，无并发竞争。流水线需要去重锁，复杂度高且省的时间有限（~30s）。
- 不要修改 `ack_cli_data` 工具——它仍然调 `fetchAllEntries(--card-id)`，先查 `reusableEntry` 缓存。预取后缓存命中，秒回。工具逻辑不变。
- 不要把 `entry.column-meta.json` 设为 `reusableEntry` 的必需项——旧缓存没有这个文件，设为必需会导致所有旧缓存失效。当前实现是可选的。
- 不要在 `remaining` 检查里只查 `reusableEntry`——预取后全部 entry 都在，`remaining` 会误判为空，跳过 Writer 直接跑 layout，导致 caption 缺失 → B2 崩。必须加 `caption.md` 存在性检查。
- B2 测试超时不要设 600s（10min）——14 卡实测 ~11min，会被杀。设 ≥ 1080000ms（18min）。
