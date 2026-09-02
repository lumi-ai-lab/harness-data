# QwenPaw Docker 部署

镜像固定 QwenPaw 2.1.0 + Harness Data 插件, 不含任何密钥。镜像在开发机(本机)构建, 导出压缩后上传服务器加载, 共 4 步:

```text
┌──────────────┐    ┌────────────────────┐    ┌──────────────┐    ┌────────────────┐
│ ① 本机构建镜像  │ →  │ ② 导出压缩上传并加载 │ →  │ ③ 准备密钥     │ →  │ ④ 运行并验证     │
│ build-docker │    │ docker save + gzip │    │ 2 个 export  │    │ run_docker.sh  │
│ -image.sh    │    │ + scp + docker load│    │ channel-auth │    │ + docker inspect│
└──────────────┘    └────────────────────┘    └──────────────┘    └────────────────┘
 (本机)               (本机 → 服务器)            (服务器)           (服务器)
```

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

> 服务器上只需镜像 + `run_docker.sh` + 密钥文件。`entrypoint.sh`、`configure_model.py`、`align_timezone.py` 在构建镜像时已 COPY 进容器 `/opt/qdm/bin/`, 无需单独上传; `Dockerfile`、`build-docker-image.sh` 只在本机构建时使用。

## ③ 准备密钥(服务器)

先导出 2 个变量:

```bash
export QDM_CHANNEL_SECRET_DIR=<密钥目录>
export QWENPAW_MODEL_API_KEY=<模型API Key>
```

再在密钥目录下放置渠道授权文件(唯一需要准备的密钥文件), 并设置属主与权限:

```bash
chown 10001:10001 "$QDM_CHANNEL_SECRET_DIR/channel-auth.json" && chmod 600 "$QDM_CHANNEL_SECRET_DIR/channel-auth.json"
```

> 密钥目录是宿主机目录, 运行 `run_docker.sh` 时自动只读挂载到容器 `/run/secrets`, 无需手动挂载。

## ④ 运行并验证(服务器)

```bash
deploy/qwenpaw/run_docker.sh
docker inspect --format '{{json .State.Health}}' qwenpaw   # 输出 healthy 即成功
```

脚本已内置以下参数, 无需额外配置:

```text
监听   127.0.0.1:8088(默认仅本机)
内存   上限 8G
时区   Asia/Shanghai(容器 TZ + config.json 的 user_timezone)
自启   --restart unless-stopped
密钥   密钥目录只读挂载到容器 /run/secrets
```

- 想调整内存上限: `export QWENPAW_MEM_LIMIT=16g` 后重跑 `run_docker.sh`。
- 想换时区: `export QWENPAW_TZ=Asia/Tokyo` 后重跑 `run_docker.sh`。
- 想让局域网/外部直连: `export QWENPAW_BIND=0.0.0.0` 后重跑 `run_docker.sh`(暴露后请自行用防火墙/反向代理限制来源)。
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
