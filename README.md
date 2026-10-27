# Grok Imagine Studio

参考 ImgX Studio 设计的自托管 **xAI Grok Imagine API** 创作工作台。零依赖、单进程 Node 服务，开箱即用。

## 功能（覆盖 Imagine API 全部能力与参数）

| 模式 | 说明 | 对应官方端点 |
|---|---|---|
| 文生图 | 提示词生成图像，1–10 张 | `POST /v1/images/generations` |
| 图片编辑 | 最多 5 张参考图 + 自然语言修改 | `POST /v1/images/edits` |
| 文生视频 | 提示词生成，1–15 秒 | `POST /v1/videos/generations` |
| 图生视频 | 首帧图 + 关键帧锚定（最多 4 个，含 timestamp_s） | `POST /v1/videos/generations` |
| 视频编辑 | 上传 / 引用源 mp4 + 文字修改 | `POST /v1/videos/edits` |
| 视频延展 | 从源视频最后一帧续写 2–10 秒 | `POST /v1/videos/extensions` |

**模型下拉不写死任何模型名**：页面加载时实时调用官方模型列表接口填充：

- `GET /v1/image-generation-models`
- `GET /v1/video-generation-models`

新模型上线即自动出现在下拉框中；图像模型还会展示官方返回的每张价格。

### 参考生视频（R2V）与语音

文生视频 / 图生视频模式下可附加：

- **参考图**（`reference_images`，最多 14 张）：锁定角色、场景、产品或风格
- **语音参考**（`reference_audios`，最多 3 条，每条 ≤15s）：上传音频文件作为声音身份，或直接填预设 `voice_id`（如 `ara`）

### 全部参数均有对应控件

- 生成类：`prompt` / `model` / `n` / `aspect_ratio` / `resolution` / `quality` / `response_format` / `duration`
- 编辑类：`image` / `images`（多图 `<IMAGE_0>` 指代）/ `video` / `keyframes` / `last_frame` / `reference_images` / `reference_audios`
- 视频生成专属：`last_frame`（末帧锚定，图生视频时与首帧插值）、`generate_audio`（音轨开关，默认开）、`keyframes`（≤4 个，1/3 秒网格）、`reference_images`（≤14）、`reference_audios`（≤3 条，音频文件或 `voice_id`）
- 高级参数面板：`deferred`（图像异步模式，自动联动 url 格式并轮询 `GET /v1/images/{request_id}`）、`user`（终端用户标识）、`output`（签名 PUT 上传地址）、`storage_options`（filename / expires_after ≤30天 / public_url，存入 xAI Files）

> **关于 `quality`**：REST 文档与 OpenAPI 规范里都没有这个字段，但实测确实生效并影响计费——`grok-imagine-image-2.0` 传 `quality=low` + 1k 计费 $0.0400，不传（默认 medium）为 $0.0600。UI 的质量下拉不写死枚举，直接从模型返回的 `pricing` 矩阵提取档位，并实时显示当前档位 × 分辨率的单张价格。

> 已知未覆盖：`image` / `images` / `video` 的 `file_id` 形式（需接入 xAI Files API 上传链路），当前统一使用公开 URL 或 base64 data URL。

### 工作流

- 拖拽 / 点击 / 粘贴上传；关键帧可设定锚定时间点
- 生成结果一键 **用作编辑源图 / 设为视频首帧 / 编辑此视频 / 延展此视频**，持续迭代
- 视频与 deferred 图像任务实时进度条；每次请求显示实际费用（`usage.cost_in_usd_ticks`）
- API Key 仅存本机浏览器 localStorage，经本机代理转发，不会上传第三方

## 快速开始

### 方式一：一键脚本（推荐）

要求 Node.js ≥ 18（内置 fetch），无任何 npm 依赖。

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

## 配置

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `XAI_API_KEY` | 否 | 服务端 Key。配置后团队成员无需各自填 Key（浏览器留空即用服务端 Key） |
| `XAI_BASE_URL` | 否 | 上游地址，默认 `https://api.x.ai` |
| `PORT` / `HOST` | 否 | 监听端口 `8187` / 地址 `0.0.0.0`（Docker 容器内为 `3210`） |
| `HTTPS_PROXY` 等 | 否 | 出站代理，见下节 |

以上变量均支持写入项目根目录 `.env` 文件（参考 `.env.example`），启动时自动加载；命令行环境变量优先于 `.env`。`server.js`、`start.sh`、Docker 三种启动方式均生效。

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

- 代理仅转发固定的 8 条路由 + 2 条轮询路由，不会成为任意 URL 的开放代理
- 浏览器直连 api.x.ai 存在 CORS 限制，因此所有请求经本服务转发
- API Key 优先级：浏览器请求头 `x-xai-key` > 服务端环境变量
- 图像默认使用 `b64_json` 返回格式，避免临时 URL 过期导致结果丢失
