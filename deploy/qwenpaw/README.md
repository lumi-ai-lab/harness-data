# QwenPaw Docker 部署

镜像固定 QwenPaw 2.1.0 + Harness Data 插件, 不含任何密钥。镜像在开发机(本机)构建, 导出压缩后上传服务器加载, 共 5 步:

```text
┌──────────────┐    ┌────────────────────┐    ┌──────────────┐    ┌────────────────┐    ┌────────────────┐
│ ① 本机构建镜像  │ →  │ ② 导出压缩上传并加载 │ →  │ ③ 准备密钥     │ →  │ ④ 运行并验证     │ →  │ ⑤ 切 Agent 并   │
│ build-docker │    │ docker save + gzip │    │ 2 个 export  │    │ run_docker.sh  │    │   绑定渠道       │
│ -image.sh    │    │ + scp + docker load│    │ channel-auth │    │ + docker inspect│   │ (绑到专用 Agent) │
└──────────────┘    └────────────────────┘    └──────────────┘    └────────────────┘    └────────────────┘
 (本机)               (本机 → 服务器)            (服务器)           (服务器)               (服务器/浏览器)
```

> 第 ⑤ 步不能跳:QDM 渠道必须绑在专用 Agent **`harness-data-default`** 上,绑到内置
> `default` 时插件不激活,企微里会回"当前会话不支持 QDM 数据查询"。操作见「⑤ 绑定渠道」,
> 原理与排查见「⑥ QDM Agent 与作用域」。

## ① 本机构建镜像

```bash
deploy/qwenpaw/build-docker-image.sh
```

- 直接运行即用脚本内固定版本; 或加 `--latest-release`, 自动按 Gitee 最新 Release 解析版本(脚本会打印解析出的版本号与镜像 tag)。
- 产出镜像 tag 为 `harness-data-qwenpaw:0.0.56-amd64`(默认版本), 与下面步骤及 `run_docker.sh` 中的引用保持一致; 用 `--latest-release` 时以脚本打印的 tag 为准。

## ② 导出压缩上传并加载

本机导出镜像并压缩, SCP 上传到服务器, 再在服务器上加载(`docker load` 可直接读 gzip, 无需先解压):

```bash
# 本机:导出并压缩
docker save harness-data-qwenpaw:0.0.56-amd64 | gzip > harness-data-qwenpaw-0.0.56-amd64.tar.gz

# 本机:上传到服务器(换成实际的服务器地址与登录用户)
scp harness-data-qwenpaw-0.0.56-amd64.tar.gz root@<服务器IP>:/tmp/

# 服务器:加载镜像, tag 与构建时保持一致
docker load -i /tmp/harness-data-qwenpaw-0.0.56-amd64.tar.gz
```

> 服务器上只需镜像 + `run_docker.sh` + 密钥文件。`entrypoint.sh`、`configure_model.py`、`align_timezone.py`、`ensure_qdm_agent.py` 在构建镜像时已 COPY 进容器 `/opt/qdm/bin/`, 无需单独上传; `Dockerfile`、`build-docker-image.sh` 只在本机构建时使用。

## ③ 准备密钥(服务器)

先导出 2 个变量:

```bash
export QDM_CHANNEL_SECRET_DIR=<密钥目录>
export QWENPAW_MODEL_API_KEY=<模型API Key>
```

把渠道授权文件放到密钥目录, 只要求"容器能读到", 不要求改属主:

```bash
chmod 644 "$QDM_CHANNEL_SECRET_DIR/channel-auth.json"
namei -l "$QDM_CHANNEL_SECRET_DIR"   # 每一级目录都要有 o+x, 否则容器内读不到
```

> `channel-auth.json` 可以由导出任务(如 ztadmin 的 cron)拥有并保持每日重写, 只要权限是 `0644`
> (或 `0640` 且容器 GID 能组读)。`run_docker.sh` 会在启动前以容器 UID 实测一次可读性, 读不到就直接报错退出。
> `session-hmac.secret` 不需要准备, 首次运行由 `run_docker.sh` 生成并 chown 给容器 UID。

> 导出任务通常把文件生成在别处(如 `/data/qdm-auth-center/channel-auth.json`), 有两种接法, 属主都
> **不需要**是容器 UID(实测 `--user 10001:10001` 读 `0644 ztadmin:ztadmin` 和 `0640 ztadmin:10001`
> 都成功, 读 `0600` 失败):
>
> - **直接把密钥目录指向导出目录**: `QDM_CHANNEL_SECRET_DIR=/data/qdm-auth-center`, 零拷贝, 但要求
>   导出产物本身可读(该文件现在是 `0600 ztadmin`, 得在导出脚本末尾补 `chmod 644 "$OUT"` 或改组
>   `0640`)。代价是整个目录都只读挂进容器 `/run/secrets`(日志、CLI 二进制、脚本一起进去), 且
>   `session-hmac.secret` 会落在导出账号可写的目录里。
> - **专用密钥目录 + 每日落地一步**(推荐, 挂载面最小):
>
>   ```cron
>   10 8 * * * install -m 644 /data/qdm-auth-center/channel-auth.json "$QDM_CHANNEL_SECRET_DIR/channel-auth.json"
>   ```
>
>   `install` 是"写临时文件再 rename"的原子替换; 导出任务若原地重写, 容器正好在导出那几分钟里读
>   就可能读到半截 JSON —— 这一步顺带避开。别用 `chown` 把文件改走, 那会夺掉导出账号自己的写权限。

> 该文件**已存在时脚本不会改动它的属主**(重新生成或改派生材料会让所有企微会话 key 漂移),
> 而旧版脚本是按 `channel-auth.json` 的属主来 chown 它的。老机器升级后先核一次:
> `stat -c '%a %U:%G' "$QDM_CHANNEL_SECRET_DIR/session-hmac.secret"`, 不是容器 UID 可读就
> `chown 10001:10001` 修一次, 不要删除重建。

> 密钥目录是宿主机目录, 运行 `run_docker.sh` 时自动只读挂载到容器 `/run/secrets`, 无需手动挂载。
> 注意是**整个目录**挂进去: 建议用一个只放上述文件的专用目录, 别把无关的私钥/配置也放进去。

## ④ 运行并验证(服务器)

```bash
deploy/qwenpaw/run_docker.sh
docker inspect --format '{{json .State.Health}}' qwenpaw   # 输出 healthy 即成功
```

> `healthy` 只代表 webserver 活着(`/healthz`), **不代表密钥可用**。密钥读不到时容器照样 healthy,
> 表现是企微里回"QDM 渠道授权不可用或被拒绝"或"Harness 上下文不可用"。确认密钥本身:

```bash
docker exec qwenpaw python -c 'import os;print([os.access("/run/secrets/"+f, os.R_OK) for f in ("channel-auth.json","session-hmac.secret")])'
docker logs --since 10m qwenpaw 2>&1 | grep -E 'qdm_query_failed|qdm_harness_context_failed' || echo "无授权/上下文失败"
```

密钥可读、`reason` 却不是授权类的失败, 先核 Root Context 的 `surface`:

```bash
docker exec qwenpaw python -c 'import json;print(json.load(open("/opt/qdm/harness-data/instance/0.0.56/context.json"))["surface"])'
```

必须落在 `chat` / `codex` / `desktop` / `work` 里。`unknown` 或字段缺失会让整次上下文注入
失败(企微回"Harness 上下文不可用", 日志 `reason=invalid_root_context`): setup 会把按 host
派生出的 surface 写进这个文件, 而 CLI 每次读取都重新校验它, 两边口径必须一致 —— 现在
host `qwenpaw` 派生为 `chat`, `Dockerfile` 里也显式传了 `--surface chat`。

脚本已内置以下参数, 无需额外配置(脚本可重复执行: 同名容器含运行中的会在启动前被停掉并
删除, 配置和数据都在命名卷里, 不会因此丢失):

```text
监听   0.0.0.0:8088(默认对局域网开放)
内存   上限 8G
时区   Asia/Shanghai(容器 TZ + config.json 的 user_timezone)
自启   --restart unless-stopped
密钥   密钥目录只读挂载到容器 /run/secrets
```

- 想调整内存上限: `export QWENPAW_MEM_LIMIT=16g` 后重跑 `run_docker.sh`。
- 想换时区: `export QWENPAW_TZ=Asia/Tokyo` 后重跑 `run_docker.sh`。
- 想收回仅本机访问: `export QWENPAW_BIND=127.0.0.1` 后重跑 `run_docker.sh`, 控制台改用 ⑤ 的端口转发访问。
- 默认 `0.0.0.0` 意味着同网段任何人都能打开控制台(默认不做登录鉴权), 请自行用防火墙/反向代理限制来源。
- 国内环境直连即可, 无需代理。

核对时区是否生效(应分别输出 `Asia/Shanghai` 与 CST/+0800):

```bash
docker exec qwenpaw python -c 'import json;print(json.load(open("/app/working/config.json"))["user_timezone"])'
docker exec qwenpaw date
```

> 时区说明:`config.json` 只在文件不存在时才会从镜像里的 seed 复制,持久卷里遗留的
> `user_timezone: Etc/UTC` 不会被新镜像覆盖。容器启动时 `entrypoint.sh` 会按运行时
> `TZ` 把它对齐(仅修正未被人工设置过的默认值,你在控制台/接口里改过的时区会保留)。
> 这一步影响的是相对日期解析:未对齐时,北京时间 00:00–08:00 之间 `get_current_time`
> 会返回前一天,"昨天"会再往前错一天。

## ⑤ 绑定渠道(必须先切 Agent)

容器 healthy 之后,企微/飞书还没接上:渠道要绑到专用 Agent 上才算配置完成。**这一步最容易踩空**。

1. 打开控制台。默认监听 `0.0.0.0:8088`, 浏览器直接访问 `http://<服务器IP>:8088`;
   若按 ④ 把监听收回过仅本机(`QWENPAW_BIND=127.0.0.1`), 从 workstation 访问要先做端口
   转发(`ssh -L 8088:127.0.0.1:8088 root@<服务器IP>`)。
2. **先把左侧栏顶部的 "Current Agent" 切到「QDM 数据助手」。** 下拉项第二行会显示
   `ID: harness-data-default`,以这个 ID 为准,别按显示名认。
3. 进 Channels 页(路由 `/channels`)配置 wecom 或 feishu,保存。
4. 验证渠道真的落在了专用 Agent 上(而不是 `default`):

```bash
docker exec qwenpaw python -c 'import json;c=json.load(open("/app/working/workspaces/harness-data-default/agent.json"))["channels"];print({k:c[k]["enabled"] for k in ("wecom","feishu")})'
# 期望 {'wecom': True, 'feishu': False} 这类至少一项为 True；
# 两项都是 False 说明渠道配到了别的 Agent 上,回到第 2 步确认切对了 Agent
```

> **为什么必须手切一次:** 侧边栏的 "Current Agent" 初值由**前端**固定在字面量 `default`
> (优先级:本标签页记忆 → 上次使用的 Agent → 字面量 `default`),**不读**宿主的
> `active_agent`。镜像虽然已经把 `active_agent` 指到 `harness-data-default`,那只管
> 不带显式 Agent 的服务端请求(API/ACP)兜底路由,管不到控制台的选择框。
> 切换一次后浏览器会记住(存在 localStorage),后续新标签页会直接落在专用 Agent 上。
>
> 配错的典型症状:企微里提问后回"当前会话不支持 QDM 数据查询",或该 Agent 的工具列表里
> 根本没有 `qdm_query`——那是作用域没命中,见下一节。

## ⑥ QDM Agent 与作用域

镜像不使用宿主内置的 `default` Agent 跑 QDM,而是在构建期新建一个符合命名约定的专用
Agent **`harness-data-default`**,并把它的 `active_agent` 指向它。`default` 仍然保留
(宿主不允许删除或禁用内置 Agent),但它不再注册任何 QDM 工具。

```text
镜像里的 agent        default(内置)          harness-data-default(QDM 专用)
渠道                  仅 console              wecom/feishu 搬到这里
active_model          不设置                  configure_model.py 写入
插件 enabled_agents   不命中 → 工具不注册      harness-data-* 命中 → 激活
```

对应到运维:

- 渠道必须绑在 `harness-data-default` 上,首次进控制台要先切一次 Agent,原因与操作见
  上一节 ⑤。
- `active_agent` 也一并指向该 Agent:它管的是不带显式 Agent 的服务端请求(API/ACP 等)兜底路由,
  不影响控制台的选择框。
- 老部署升级镜像时会自动完成两件事,无需手工搬配置:新建 `harness-data-default`,并把
  `default` 上**已启用**的 wecom/feishu 渠道连同凭证**搬移**过去(`default` 侧同时置为禁用)。
  必须是搬移而不是复制:每个启用中的 Agent 都会各自启动一份渠道管理器,两边同时持有同一份
  凭证就是双份连接、消息被消费两次。日志里以 `qdm agent bootstrap: moved …` 打印。
- 若某个渠道在新旧两个 Agent 上都已启用,脚本只告警不擅自关闭任何一个,需要人工二选一:
  `left wecom enabled on both default and harness-data-default; disable one of them…`
- 想再开一个 QDM 入口:新建 Agent 时把 **ID**(不是显示名)填成 `harness-data-xxx`,零配置生效。
  ID 创建后不可修改;留空会让宿主生成随机短 UUID,复制/派生出的 Agent 同理,都不会激活。
- 想换专用 Agent 的 id:改 `Dockerfile` 里的 `ARG QWENPAW_QDM_AGENT_ID` 默认值。它同时决定
  workspace 目录名与插件作用域,`build-docker-image.sh` 不转发这个参数,也不要在运行期单独
  覆盖 `QWENPAW_QDM_AGENT_ID`——那会让镜像烘焙进去的 workspace 白名单和实际 Agent 对不上。

改名做不到"把 default 变成 harness-data-default":宿主在每次启动都会无条件补建
`profiles.default`(且 `/healthz` 的就绪门以它是否启动成功为开关,删掉它会让容器
永久停在 starting),所以这里只能是"新增专用 Agent + 改指向",`default` 与内建 QA
Agent 会一直保留在列表里。

QDM 职责挪出 `default` 之后,有三件事的作用对象仍然是 `default`(宿主按 id 写死,不是本
部署能改的),如果依赖请到 `default` 上配置:

```text
cron / 定时任务   CronManager 取的是 default 的 workspace,`/crons/*` 与 slash 命令
                  管理不到 harness-data-default 的 jobs.json
治理策略目录      按 workspace 目录名归属,在 default 上调过的策略不会跟到新 Agent
CLI 配渠道        `qwenpaw channels config` 的 --agent-id 默认值就是 default,
                  用脚本配渠道时必须显式传 --agent-id harness-data-default
```

确认作用域真的命中了某个 Agent(`matched=none` 表示插件处于"装了但谁都不服务"的状态):

```bash
docker exec qwenpaw /app/working/plugins/qdm-harness-qwenpaw/scripts/harness-data \
  qwenpaw doctor \
  --plugin-root /app/working/plugins/qdm-harness-qwenpaw \
  --plugin-config-file /etc/qdm/qwenpaw/plugin-config.json \
  --qwenpaw-working-dir /app/working --json | grep -A3 '"agent-scope"'
```

未命中时 `qdm_query` 不会出现在该 Agent 的工具列表里(不会留下一个必然报错的工具);
若配置里的作用域不可用,插件按 fail-closed 处理,同样不注册工具、不注入上下文。

工具面口径由 `Dockerfile` 里 setup 的 `--tool-policy` 决定,写进插件配置的 `tool_policy`,
**当前镜像是 `preserve`**:作用域内的 Agent 保留宿主默认的全量工具(shell/文件都在),
这样企微里发来的 xlsx、截图才能交给 `officecli-*` / `charts-cli` 技能处理。

改成 `--tool-policy strict` 会把作用域内 Agent 的工具面收窄到 `qdm_query` /
`qdm_scope_summary` / `get_current_time` 三个,同时关掉工具结果裁剪。这是更强的一层:
`/run/secrets/channel-auth.json` 与 `session-hmac.secret` 必须对容器运行 UID 可读(插件
进程内要按渠道用户解出 blob),0600 不是隔离手段,`preserve` 下渠道用户能让模型跑 shell,
`strict` 才把这条路关掉。代价是模型不能再自己 grep wikis 或用 shell 分析上传的文件,
答案完全依赖注入的上下文,因而 `context --format qwenpaw-hook` 的"选中的手册必须全部内嵌,
否则整次请求失败"是它的前置条件。

核对与回退:

```bash
# 打印当前口径; strict 下 detail 里的 offenders=none 才表示确实只剩 QDM 三个
docker exec qwenpaw /app/working/plugins/qdm-harness-qwenpaw/scripts/harness-data \
  qwenpaw doctor --plugin-config-file /etc/qdm/qwenpaw/plugin-config.json \
  --qwenpaw-working-dir /app/working --json | grep -A3 '"tool-allowlist"'
```

两个方向都靠改 `Dockerfile` 里 setup 的 `--tool-policy` 再重新构建; `preserve` 下 setup 不写
任何 `agent.json`。开发实例(`scripts/plugin-dev-init-qwenpaw.mjs`)故意保留 `preserve`,它把
`default` 也放进了作用域,strict 会连带削掉控制台在用的工具。

> 工具面每次启动都会被对齐: `ensure_qdm_agent.py` 读插件配置的 `tool_policy`
> (`QWENPAW_QDM_TOOL_POLICY` 可临时覆盖),strict 收窄、preserve 放开,幂等。所以老部署升级
> 镜像不会遗留旧口径 —— 日志里 `opened tools ... to the QwenPaw default allowlist` 就是
> preserve, `narrowed tools ... to the QDM strict allowlist` 就是 strict。只用环境变量覆盖
> 会让运行中进程与烘焙进 `/etc/qdm/qwenpaw/plugin-config.json` 的口径不一致(插件自身的工具
> 可见性读的是那份配置),长期切换请改 `Dockerfile` 重建。

引导逻辑本身有一组不依赖宿主的单测:

```bash
python3 -m unittest discover -s deploy/qwenpaw -p 'test_*.py'
```
