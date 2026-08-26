# WorkBuddy html-report 进度同步

## 目标

让 WorkBuddy 在执行 html-report 时看到阶段和卡片进度，复用当前
Stage Runner 的状态与 settlement，不引入第二套 session 状态。

本方案只解决 WorkBuddy 的用户可见进度，不把 Codex Plugin 和 WorkBuddy
改造成共享运行时。

## 现状

Codex Plugin 已通过 MCP 返回 `total`、`completed`、`active` 和 `next`。
WorkBuddy 由 `html-report-stage-runner.mjs` 负责 Gate 和阶段推进，状态保存在：

```text
.harness/state/html-report/<session>/debug/pipeline-state.json
```

WorkBuddy 当前主要在 `advance` 完成后输出摘要。B2 Writer 使用并发子进程，
长任务执行期间缺少逐卡反馈。

## 精简架构

```text
+------------------+
| WorkBuddy 父会话 |
+--------+---------+
         |
         | advance / status
         v
+------------------------------+
| html-report-workbuddy.mjs    |
| 薄入口 / 输出适配器           |
+---------------+--------------+
                |
                v
+------------------------------+
| html-report-stage-runner.mjs|
| Gate 阶段编排                |
+--------+----------+----------+
         |          |
         |          +----------------------+
         |                                 |
         v                                 v
+----------------------+          +------------------+
| pipeline-state.json  |          | onProgress()     |
| 唯一状态源           |          | 进度摘要回调     |
+----------------------+          +--------+---------+
                                             |
                                             v
                                      +--------------+
                                      | stdout       |
                                      | WorkBuddy 显示|
                                      +--------------+

              B2_WRITER
                   |
                   v
+------------------------------+
| Writer 调度器                |
| 复用现有并发配置              |
+-----+------------+-----------+
      |            |
      v            v
+-----------+  +-----------+
| Writer 子进程|  | Writer 子进程|
| cardId=A  |  | cardId=B  |
+-----+-----+  +-----+-----+
      |              |
      +------+-------+
             v
+------------------------------+
| settlement / caption 文件   |
| 按 cardId 确认完成状态        |
+---------------+--------------+
                |
                v
          +-------------+
          | 触发进度回调 |
          +-------------+
```

## 设计规则

1. `pipeline-state.json` 是 WorkBuddy 的唯一状态源。
2. `status` 直接读取现有 Gate、settlement 和 caption 状态。
3. `advance` 接受可选的 `onProgress` 回调，默认不改变现有调用方行为。
4. 子进程原始 stdout/stderr 不回流父会话，只输出 Runner 生成的摘要。
5. 并发 Writer 使用稳定的 `cardId`，不使用数组下标作为身份。
6. Codex Plugin 保持现有 MCP 返回格式，不读取 WorkBuddy 状态。

## 输出时机

```text
B2_WRITER 开始
    -> 卡片进入处理
    -> 卡片 settlement 成功或失败
    -> B2_WRITER 完成或失败
    -> B2_MAIN 等待人工 Gate
```

默认文本示例：

```text
正在执行 B2_WRITER
B2_WRITER 已完成 2/5 张卡
B2_WRITER 卡片 sales_trend 失败：指标不支持筛选维度 region
B2_WRITER 完成，等待 B2_MAIN Gate
```

`status` 仍用于进程结束后的查询。它只展示已落盘状态，不承诺跨进程的
实时 `running` 状态。

## 最小实现

只修改以下两个入口和对应测试：

```text
.agents/workbuddy/scripts/html-report-stage-runner.mjs
    增加 advance/runWriterStage 的可选 onProgress

.agents/workbuddy/scripts/html-report-workbuddy.mjs
    将 onProgress 转换为 stdout 文本

.agents/workbuddy/scripts/*test.mjs
    覆盖串行、并发、失败和 retry
```

不新增：

- `progress.json` 或其他持久化状态文件；
- 共享 `ReportProgress` kernel 模块；
- Codex MCP Adapter 或新的事件总线；
- WorkBuddy 父会话对子进程日志的透传。

## 验收标准

- 两张以上卡片并发执行时，WorkBuddy 能看到每张卡完成或失败摘要。
- 单卡失败时，进度保留已成功卡片数量，并提示 `retry --task <cardId>`。
- Runner 重启后，`status` 能从现有文件恢复已完成数量。
- 不新增状态源，不改变 Codex Plugin 现有 MCP 返回结构。
- 现有 Stage Runner contract 测试全部通过。

## 后续边界

只有在 WorkBuddy 宿主明确需要机器消费进度时，才增加 `--format json`；
即使增加，也应从现有状态派生，不新增进度文件。B25/B3/B4/B5 暂不扩展
逐任务实时事件，沿用阶段级 Gate 摘要。
