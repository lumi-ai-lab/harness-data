# CMR CLI 使用说明

该文件是 QDM harness 注入给智能体的 CMR CLI 使用手册。它只描述工具调用方式、参数边界和失败恢复规则；具体报告需要查询哪些模块，以各报告 routing、playbook 和 report spec 为准。

## 基本原则

- 必须先读取当前项目的 `config/qdm-cli-paths.env`，使用其中的 `$QDM_CMR_CLI`。
- 不得使用本地示例值、缓存文件或手工估算替代 CLI 返回值。
- 不确定某个命令或参数时，先运行 `"$QDM_CMR_CLI" <command> -h` 查看帮助，不得猜测参数。
- 只能使用 CLI 文档中明确存在的参数；禁止自行发明参数。

## 启动方式

```bash
source config/qdm-cli-paths.env
"$QDM_CMR_CLI" <command> ...
```

## 命令树

CMR CLI 常用命令：

```text
qdm-cmr-cli report <alias> [subcommand] [filters] [options]
qdm-cmr-cli table --report <alias> --indicator <name-or-code> --dim-type <name-or-code> [filters] [options]
qdm-cmr-cli search <selector> [options]
```

支持的 report alias：

- `business`: 经营分析
- `store`: 门店管理
- `user`: 用户运营
- `company`: 公司/财务报表

`report <alias>` 常用 subcommand：

- `overview`: 一次查询页面主要模块
- `indicators`: 查询核心指标或杜邦图数据
- `tree --values`: 查询指标树及节点值
- `area`: 查询区域维度表现
- `category`: 查询品类维度表现
- `trend`: 查询时间趋势
- `inspect`: 只解析过滤条件，不查询业务数据
- `full`: 返回后端完整响应

## 时间参数

CMR CLI 时间参数只允许以下三种，且三选一：

```text
--date YYYY-MM-DD
--week YYYY-NN
--month YYYY-MM
```

`--week` 使用 CMR 业务周编码，不使用 ISO 周格式。业务周编码形如 `2026-20`，可通过 `"$QDM_CMR_CLI" search weeks --ai` 查询；输出中的 `value` 可以直接传给 `--week`。

示例：

```bash
"$QDM_CMR_CLI" report business overview --date 2026-05-21
"$QDM_CMR_CLI" report business overview --week 2026-20
"$QDM_CMR_CLI" report business overview --month 2026-05
```

禁止使用以下不存在或不支持的时间参数：

```text
--date 2026-05-17..2026-05-23
--week 2026-W21
--start-date 2026-05-17
--end-date 2026-05-23
--from 2026-05-17
--to 2026-05-23
```

需要周或月口径时，使用 `--week` 或 `--month`，不要用日期范围模拟。
如果不确定当前可用周编码，先运行：

```bash
"$QDM_CMR_CLI" search weeks --page-size 5 --ai
```

## 常用过滤参数

```text
--area-type <name-or-code>       例如 管理区域 或 manageAreaId
--area <name-or-id>              例如 CN00 或 华南
--category-type <name-or-code>   例如 大分类 或 categoryLevel1Id
--category <name-or-id>          例如 00 或 水果
--indicator <name-or-code>       例如 品效 或 brandProductEffectiveness
--display-mode yoyMom|thresholdRatio
```

禁止自行发明聚合参数，例如：

```text
--group-by
--granularity
--metric
--dimension
```

需要维度明细时，优先使用 `table --dim-type` 或 report 已有的 `area/category/trend` 子命令。

## AI 压缩输出

`--ai` 会把默认输出中的核心数组压缩成适合模型读取的 `#cols/#data` 格式。只有 CLI README 或 `-h` 明确列出的命令才允许追加 `--ai`。

支持 `--ai` 的常用命令：

- `search store-types`
- `search category-types`
- `search stores`
- `search categories`
- `search weeks`
- `search indicators`
- `search indicators tree`
- `report <alias>`
- `report <alias> indicators`
- `report <alias> area`
- `report <alias> category`
- `report <alias> trend`
- `report <alias> overview`
- `table`

`tree --values` 不追加 `--ai`。

如果某个支持 `--ai` 的命令返回：

```text
ai output requires a JSON array
```

必须去掉 `--ai`，用相同过滤条件重试同一命令。不得改用未验证参数绕过。

## 查询帮助

常用帮助命令：

```bash
"$QDM_CMR_CLI" -h
"$QDM_CMR_CLI" report business -h
"$QDM_CMR_CLI" report business overview -h
"$QDM_CMR_CLI" report store -h
"$QDM_CMR_CLI" report user -h
"$QDM_CMR_CLI" report company -h
"$QDM_CMR_CLI" table -h
```
