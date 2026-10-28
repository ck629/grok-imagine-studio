# Grok Imagine Studio

参考 ImgX Studio 设计的自托管 **xAI Grok Imagine API** 创作工作台。零依赖、单进程 Node 服务，开箱即用。

## 功能（覆盖 Imagine API 全部能力与参数）

| 模式 | 说明 | 对应官方端点 |
|---|---|---|
| 文生图 | 提示词生成图像，1–10 张 | `POST /v1/images/generations` |
| 图片编辑 | 最多 5 张参考图 + 自然语言修改 | `POST /v1/images/edits` |
| 文生视频 | 提示词 / 参考图 / 尾帧生成，1–15 秒（旧版 10 秒） | `POST /v1/videos/generations` |
| 图生视频 | 首帧图 + 关键帧 / 末帧锚定 + 参考图 / 语音 | `POST /v1/videos/generations` |
| 视频编辑 | 上传 / 引用源 mp4 + 文字修改 | `POST /v1/videos/edits` |
| 视频延展 | 从源视频最后一帧续写 2–10 秒 | `POST /v1/videos/extensions` |

**模型下拉不写死任何模型名**：页面加载时实时调用官方模型列表接口填充：

- `GET /v1/image-generation-models`
- `GET /v1/video-generation-models`

两个端点均返回 `{"models": [...]}` 结构（非 `data`）。新模型上线即自动出现在下拉框中；图像模型会展示官方 `pricing` 矩阵里的单张价格。

> 若视频下拉是空的，通常是该 API Key 所在团队**没有视频模型权限**（接口返回空数组），不是页面故障。

**模型能力随版本不同**（官方约束，界面不写死模型名，只做提示）：

- `last_frame` / `keyframes` / 锁定首帧 / 语音参考：仅 1.5 系模型支持，旧版会直接报错
- 视频时长：1.5 系最长 15 秒，旧版最长 10 秒
- 参考生视频（R2V）：1.5 系最多 14 张参考图，旧版最多 7 张；R2V 输出最高 720p
- 图生视频的 `aspect_ratio` 会被 API 忽略，输出宽高比跟随首帧图片（界面对此已隐藏该选项并给出提示）
- 视频编辑：不支持自定义时长与分辨率，输出沿用原视频且上限 720p

### 参考生视频（R2V）与语音

文生视频 / 图生视频模式下可附加：

- **参考图**（`reference_images`）：锁定角色、场景、产品或风格；1.5 系最多 14 张，旧版最多 7 张
- **语音参考**（`reference_audios`，最多 3 条）：官方目前主要支持**预设音色 `voice_id`**（如 `ara`、`eve`）；上传自定义音频文件需向 xAI 申请成为可信合作伙伴，普通账号传音频可能被拒

### 全部参数均有对应控件

- 图像端点（`/v1/images/generations`、`/v1/images/edits`）：`prompt` / `model` / `n` / `aspect_ratio` / `resolution` / `quality` / `response_format` / `deferred` / `image` / `images`（多图用 `<IMAGE_0>` 等指代）/ `output` / `storage_options` / `user`
- 视频端点（`/v1/videos/generations`、`edits`、`extensions`）：`prompt` / `model` / `duration` / `aspect_ratio` / `resolution` / `image` / `last_frame` / `keyframes` / `reference_images` / `reference_audios` / `generate_audio` / `video` / `output` / `storage_options` / `user`
- 视频专属说明：`last_frame`（末帧锚定，与首帧同时给出则两帧插值）、`generate_audio`（音轨开关，默认开）、`keyframes`（≤4 个，1/3 秒网格，两帧至少间隔 1/3 秒）、`reference_images`（1.5 系 ≤14 / 旧版 ≤7）、`reference_audios`（≤3 条，预设 `voice_id`；自定义音频需官方授权）
- 高级参数面板：`deferred`（图像异步模式，自动联动 url 格式并轮询 `GET /v1/images/{request_id}`）、`user`（终端用户标识）、`output`（签名 PUT 上传地址）、`storage_options`（filename / expires_after ≤30天 / public_url，存入 xAI Files）

> **关于 `quality`**：它确实存在，取值 `low` / `medium` / `auto`（默认 `auto`），目前仅 `grok-imagine-image-2.0` 支持；但**官方 REST 参考页与 OpenAPI 规范里都没列这个字段**，只有图像生成能力文档里有。`auto` 的行为：文生图按 `low` 计费、图片编辑按 `medium` 计费。实测（已扣费验证）：`grok-imagine-image-2.0` + 1k，`quality=low` 计$0.0400，不传（默认 auto→medium）为 $0.0600。UI 的质量下拉不写死枚举，从模型返回的 `pricing` 矩阵提取档位，并实时显示当前档位 × 分辨率的单张价格。

> 图片编辑最多 **5 张**参考图；默认输出宽高比**跟随第一张输入图**，可用 `aspect_ratio` 覆盖。
> 分辨率取值以 REST 枚举为准：`1k` / `1.5k` / `2k`（能力文档只写了 1k/2k，但接口与价目表均接受 1.5k）。

> 已知未覆盖：`image` / `images` / `video` 的 `file_id` 形式（需接入 xAI Files API 上传链路），当前统一使用公开 URL 或 base64 data URL。

### 工作流

- 拖拽 / 点击 / 粘贴上传；关键帧可设定锚定时间点
- 生成结果一键 **用作编辑源图 / 设为视频首帧 / 编辑此视频 / 延展此视频**，持续迭代
- 视频与 deferred 图像任务实时进度条；每次请求显示实际费用（`usage.cost_in_usd_ticks`）
- **失败信息完整可见**：任务失败时卡片会显示「错误码 + 上游原始原因 + 中文解读 + `request_id`」，并可展开查看原始响应 JSON；常见码如 `invalid_argument`（参数/审核）、`permission_denied`（无权限）、`failed_precondition`（模型不支持该操作，如旧版模型用尾帧）、`service_unavailable`（上游过载）都会给出对应建议
- API Key 两种存放方式：服务端 `.env` 的 `XAI_API_KEY`（团队共用）或浏览器设置里单独填（仅存本机 localStorage）；请求统一经本机服务转发，不经任何第三方

### 参数记忆（跨刷新、跨设备）

上次使用的参数会自动记住，刷新页面、关掉浏览器、换一台设备打开同一个服务地址都会恢复：

- 记忆项：当前模式、图像/视频模型、宽高比、分辨率、质量档位、生成数量、返回格式、deferred、音轨开关、时长、`user` 标识
- 存储：服务端 `data/prefs.json`（同一服务下的所有设备共享，**换设备也能恢复**），同时写一份浏览器 localStorage 作为离线兜底
- 参数一变即自动保存（400ms 防抖），无需手动操作；删除 `data/prefs.json` 即恢复默认
- 注意：服务端无登录体系，参数是**该服务实例共享**的——团队多人使用时，最后修改的人生效

## 快速开始

### 方式一：一键脚本（推荐）

要求 Node.js ≥ 18，不使用任何第三方 npm 依赖（不执行 `npm install`）。

```bash
cd grok-imagine-studio
./start.sh
```

脚本会自动定位 Node、校验版本并启动，默认端口 **8187**。

**配置持久化（推荐）**：复制 `.env.example` 为 `.env` 并填入 Key，启动时自动加载，无需每次输入环境变量：

```bash
cp .env.example .env
# 编辑 .env: XAI_API_KEY=xai-xxx
./start.sh
```

优先级：命令行环境变量 > `.env` 文件 > 默认值。也可临时覆盖：

```bash
PORT=9000 ./start.sh                    # 自定义端口
XAI_API_KEY=xai-xxx ./start.sh          # 临时指定服务端 Key
```

打开 http://127.0.0.1:8187 ，若 `.env` 未配 Key，点击右上角 **设置** 填入 xAI API Key（在 console.x.ai 创建）。

### 方式二：直接运行

```bash
node server.js
```

启动后控制台会打印监听地址（默认 `http://0.0.0.0:8187`）。本机访问 `http://127.0.0.1:8187`；手机或同局域网设备访问 `http://<电脑局域网IP>:8187`。

### 方式三：systemd 开机自启（长期运行）

项目自带安装脚本，会把当前目录的绝对路径和 Node 路径写进 unit 文件：

```bash
cd grok-imagine-studio
./install-service.sh              # 用户级服务（默认，无需 sudo）
./install-service.sh --system     # 系统级服务（需 sudo，多用户共用时用）
./install-service.sh uninstall    # 卸载
```

用户级服务要「开机即启动、不必先登录」，需要再执行一次（否则只在登录后才启动）：

```bash
sudo loginctl enable-linger $USER
loginctl show-user $USER --property=Linger   # 应显示 Linger=yes
```

常用命令：

```bash
systemctl --user status  grok-imagine-studio    # --system 时去掉 --user，下同
systemctl --user restart grok-imagine-studio
systemctl --user stop    grok-imagine-studio
journalctl --user -u grok-imagine-studio -f     # 实时日志
```

要点：

- **systemd 不会继承你终端里的环境变量**，所以 `XAI_API_KEY`、`HTTPS_PROXY`、`PORT` 都必须写进项目根目录的 `.env`（server.js 启动时自动加载），改完 `.env` 后 `systemctl --user restart grok-imagine-studio` 生效
- unit 已设 `Restart=always`、`RestartSec=3`，进程崩溃会自动拉起（已实测 kill -9 后 3 秒内恢复）
- 若用 systemd 管理，就不要再手动 `./start.sh`，两者会抢同一端口

## 配置

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `XAI_API_KEY` | 否 | 服务端 Key。配置后团队成员无需各自填 Key（浏览器留空即用服务端 Key） |
| `XAI_BASE_URL` | 否 | 上游地址，默认 `https://api.x.ai` |
| `PORT` / `HOST` | 否 | 监听端口 `8187` / 监听地址 `0.0.0.0`（局域网可访问） |
| `HTTPS_PROXY` 等 | 否 | 出站代理，见下节 |

以上变量均支持写入项目根目录 `.env` 文件（参考 `.env.example`），启动时自动加载；命令行环境变量优先于 `.env`。`server.js`、`start.sh`、systemd 三种启动方式均生效（systemd 场景务必用 `.env`，它不继承终端环境变量）。

## 出站代理

服务端访问 `api.x.ai` 需要走代理时，在 `.env` 中配置即可（零依赖实现，仅作用于服务端到上游的请求，不影响浏览器访问本服务）：

```bash
# HTTP 代理 (https 目标自动走 CONNECT 隧道, 可带认证)
HTTPS_PROXY=http://127.0.0.1:7890
# SOCKS5 代理 (socks5h 由代理解析 DNS, 推荐; 可带认证)
HTTPS_PROXY=socks5h://127.0.0.1:1080
# 免代理主机
NO_PROXY=localhost,127.0.0.1
```

支持 `HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY` 逐级兜底（小写同名变量同样有效）。启动日志会打印已启用的代理（密码自动脱敏）。

### 连不上 xAI 时怎么排查

浏览器打开 `http://<你的地址>:8187/api/diag`，会返回当前代理配置、上游状态码与耗时：

```json
{"ok":true,"proxy":"http://127.0.0.1:7890","upstreamStatus":401,"ms":756,
 "sample":"{\"code\":\"unauthenticated:no-credentials\"}"}
```

- `upstreamStatus: 401` 表示**网络已通**（401 只是没带 Key，属正常）
- `ok:false` + `error` 会给出具体原因，常见情况：
  - `代理 CONNECT 失败: HTTP/1.1 403/407` → 代理拒绝该目标或需要认证（用 `http://user:pass@host:port`）
  - `代理地址格式无法解析` → 缺少协议头，写全 `http://` 或 `socks5h://`
  - `请求超时` → 代理未运行 / 端口不对 / 不支持 CONNECT（Clash 混合端口 7890 同时支持 HTTP 与 SOCKS）
- `NO_PROXY` 误配也会导致直连（如设了 `*`）

## 架构与安全

```
浏览器 ──> server.js（本机代理，白名单路由） ──> https://api.x.ai/v1/...
```

- 仅转发白名单内的上游路由（模型列表 2 条 + 生成/编辑 5 条 POST + 轮询 2 类），其余路径一律 404，不会成为任意 URL 的开放代理
- 浏览器直连 api.x.ai 存在 CORS 限制，因此所有请求经本服务转发
- API Key 优先级：浏览器请求头 `x-xai-key` > 服务端 `.env` 的 `XAI_API_KEY`
- 图像默认使用 `b64_json` 返回格式，避免临时 URL 过期导致结果丢失
- 本地接口：`GET /api/health`（运行状态）、`GET /api/diag`（上游连通性）、`GET|POST /api/prefs`（参数记忆）

## 目录结构

```
grok-imagine-studio/
├── start.sh            # 一键启动（自动找 Node、校验版本、提示 .env）
├── install-service.sh  # 安装 systemd 开机自启（用户级 / --system / uninstall）
├── systemd/
│   └── grok-imagine-studio.service   # unit 模板（占位符由安装脚本替换）
├── .env.example        # 配置模板（复制为 .env 填 Key / 代理，自动加载）
├── server.js           # 零依赖 Node 服务器：静态托管 + xAI API 白名单代理 + .env 加载
├── proxy.js            # 零依赖出站代理：HTTP CONNECT / SOCKS5，含超时与断连保护
├── package.json
├── data/               # 运行时生成：prefs.json（参数记忆），无需提交
└── public/
    ├── index.html      # 界面骨架（六模式 + 全参数面板）
    ├── style.css       # 深色工作台主题
    └── app.js          # 模式逻辑 / 动态模型下拉 / 异步轮询 / 迭代操作
```
