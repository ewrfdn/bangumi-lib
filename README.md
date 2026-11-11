# AniShare

个人番剧库与在线播放器，采用独立的 Vue 3 前端和 Fastify API 后端。
支持多个媒体库、SQLite 观看历史、密钥登录、直放 / HLS 转码、外挂 / 内挂字幕，以及 Pi Agent 模型配置。
右下角提供「媒体助手」悬浮窗，可通过 WebSocket 多轮对话查询媒体库、任务与观看进度，并按需执行扫描、抓取与归档。

影视目录的 SQLite 结构见 [数据库设计](docs/database-design.md)，新增接口见 [影视库 API](docs/catalog-api.md)。后端自动升级到 v5 并创建业务表及数据源字段；现有页面接口保持兼容，自动扫描 / 下载执行器尚未接入。

单条番剧资料支持 Bangumi 模糊搜索、ID / 链接预览及导入，配置与调用方式见 [元数据 API](docs/metadata-api.md)。各爬取来源独立配置代理，统一返回影视库字段。

## 本地开发

需要 **Node.js >= 22.19**（Pi SDK 要求）和 npm。视频探测、字幕提取和转码需要 ffmpeg / ffprobe。

后端配置放在 `server/.env`，前端配置放在 `web/.env`，分别参照 `server/.env.example` 和 `web/.env.example` 创建。
已有配置请保留，尤其是媒体目录、登录密钥和数据库路径。需要登录或 AI 后台时，在后端配置中设置 `AUTH_SECRET`。
后端默认只加载 `server/.env`，不会读取根目录 `.env`；从旧版本迁移时保留原配置值。

打开两个终端，均从项目根目录开始。终端一启动后端：

```bash
cd server
npm install
npm run dev
```

终端二启动前端：

```bash
cd web
npm install
npm run dev
```

前端默认 `http://localhost:6001`，API 默认 `http://127.0.0.1:8088`。开发和预览均固定使用配置端口，占用时直接报错，不自动切换。
不要使用 6000：Chromium 浏览器（包括 Chrome、Edge）将它列为受限端口，访问时可能出现 `ERR_UNSAFE_PORT`。
前端通过 Vite 的 `/api` 代理访问后端；修改后端端口后，同时修改 `web/.env` 中的 `API_TARGET`。
两个项目分别安装依赖和运行，根目录不提供 npm 脚本，也不使用 npm workspaces。

生产环境分别运行后端和构建前端：

```bash
# 后端：从项目根目录进入 server
cd server
npm install --omit=dev
npm start
```

```bash
# 前端：另一个终端从项目根目录进入 web
cd web
npm install
npm run build             # 生成 web/dist，部署到 Nginx 等静态服务器
npm run preview           # 可选：本地预览构建结果，/api 代理到后端
```

需要项目提供的 ffmpeg 安装脚本时，在 `server` 中执行 `npm run setup:ffmpeg`，或在根目录执行 `node scripts/install-ffmpeg.mjs`。

后端访问 `/`、`/admin` 等前端路径返回 JSON 404。生产环境请单独部署前端，或使用下面的双服务 Docker 部署。

## 分层结构

前后端各自维护 `package.json`、`package-lock.json` 和 `node_modules`；根目录没有共享依赖清单或 workspace 配置。

```text
server/package.json           # 后端独立依赖与启动、构建、测试脚本
server/package-lock.json      # 后端独立依赖锁
server/tsconfig.json          # strict TypeScript 配置（src → dist）
server/.env.example           # 后端配置模板，首次使用时创建 server/.env
server/.env                   # 后端实际配置，不提交到版本库
server/config/tasks.yaml      # 定时任务注册表，修改后热加载
server/src/                   # 全部为 TypeScript
├── index.ts                  # 进程启动、监听、退出
├── app.ts                    # 组装 Model、Service、Controller、Agent
├── routes.ts                 # 注册 Controller，无业务逻辑
├── config.ts                 # 服务端环境变量
├── errors.ts                 # 跨层应用错误
├── types.ts                  # 领域实体与共享接口
├── controller/               # HTTP 参数、Cookie、响应、错误映射
├── service/                  # 业务校验与编排，不依赖 Fastify
├── model/                    # SQLite、媒体文件与配置密钥持久化
├── crawler/                  # Bangumi / 豆瓣抓取，带超时与重试
├── scheduler/                # 定时任务基类、注册表、cron 调度与热加载
│   └── tasks/                # 具体任务，继承 BaseTask
└── agent/                    # Agent 定义与调度
    ├── AgentManager.ts       # 注册、分派、统一模型配置
    ├── base.agent.ts         # 基类：提示词、工具、预算
    ├── agents/               # 具体 Agent（番剧整理、媒体助手）
    ├── tools/                # 媒体库读写与对话查询工具
    └── pi.runtime.ts         # 官方 Pi SDK 适配、模型请求、取消、超时
```

web/
├── package.json              # 前端独立依赖与开发、构建、测试脚本
├── package-lock.json         # 前端独立依赖锁
├── .env.example              # 前端配置模板，复制为 web/.env
├── .env                      # 前端实际配置，不提交到版本库
├── src/views/                # 首页、媒体库、作品详情、浏览、播放器、登录、后台管理
├── src/api.js                # 通过 /api 调用后端
├── src/components/AgentChat.vue  # 右下角媒体助手悬浮窗
├── Dockerfile                # 独立前端镜像
└── vite.config.js            # 开发和本地预览代理（含 /api WebSocket）

Dockerfile                    # 独立 API 镜像，含 ffmpeg
deploy/nginx.conf             # 前端 SPA、/api（含媒体助手 WebSocket）与 /assets/bangumi 反向代理
docker-compose.yml            # web + server 两个服务
```

调用方向是 `Controller → Service → Model / Agent`。
Controller 只负责传输层；Service 负责业务和任务编排；Model 负责数据与文件读写；Agent 隔离外部 Pi SDK。
媒体转码与 HLS 分段留在播放 Service 中，原有 Range、HEAD、字幕及媒体库接口保持兼容。

## 媒体库与历史

媒体库的种类和 ID 由代码固定，环境变量只提供目录：

```dotenv
# 番剧库（必定存在）；未配置时回退 BANGUMI_ROOT / MEDIA_ROOT / ~/bangumi
BANGUMI_LIBRARY=D:/Anime
# 电影库：配置后才存在
MOVIE_LIBRARY=E:/Movies
```

路径是服务端目录，Windows 建议使用正斜杠，Linux 可以使用 `/srv/anime` 等绝对路径。
`MEDIA_LIBRARIES` 已废弃，保留配置会阻止启动；旧数据库中的 `default` 库会在迁移时自动归入 `bangumi`。

首页提供继续观看、最近看的番剧和按日期分组的观看历史；媒体库页支持切换目录、搜索和文件浏览。海报优先使用已绑定媒体的 Bangumi 封面，点击作品进入详情页，可查看抓取资料并按季选集播放；没有绑定媒体的目录仍按磁盘内容显示。扫描已绑定目录时为视频抽取中间帧生成 480p 本地封面，写入 `local_media_video.cover_path`，用于无在线封面时的海报和详情页每集缩略图；同时依据 Bangumi 总集数把视频区分为正片和番外，并记录时长、分辨率、总帧数。
两个库中相同的相对视频路径分别保存进度、封面和字幕。离线库不影响其他库；移除库后仍可删除保留的历史。

目录可以任意分层，推荐：

```text
~/bangumi/
└── 番剧名/
    ├── poster.jpg
    └── Season 1/
        ├── 番剧名 S01E01.mkv
        └── 番剧名 S01E01.chs.ass
```

支持 H.264 / VP9 / AV1 等原生直放；不兼容的编码或 MKV 等容器通过 ffmpeg 转成 H.264 HLS。
硬件编码不可用时自动回退 libx264。封面识别 poster / cover / folder 等名称；字幕支持 ASS、SSA、SRT、VTT 和内封文本字幕，图形字幕不能直接转换为文本外挂。
内挂字幕后端按需提取为 WebVTT：首次切换时 ffmpeg 边读取整个视频边把 VTT 流式返回（首条字幕很快显示，不必等整段提取完成），结果按「文件 + 大小 + mtime + 轨道」缓存在 `DATA_DIR/subtitles/`；再次选择同一字幕直接命中缓存。外挂字幕转换结果同样缓存。

## 登录与后台管理

设置 `AUTH_SECRET` 后开启单密钥登录；未设置时媒体库保持免登录。
模型服务配置及 Agent 调用始终要求已配置登录并持有有效会话。

登录后进入“后台管理 → 模型服务”，填写：

- API 格式：OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages。
- Base URL：OpenAI 兼容服务一般包含 `/v1`；Anthropic 一般填写服务根地址。
- 模型 ID：供应商提供的完整模型名称。
- API Key：支持保存或明确移除；留空保持现有密钥。本地免鉴权服务可以不填。
- 最大输出 Token 和超时：可在高级设置中调整。

“测试连接”用当前草稿执行一次实际 Pi Agent 请求，不自动保存；“保存配置”写入 SQLite，立即生效。
API Key 用 AES-256-GCM 加密，GET 接口只返回是否已配置，不返回原始密钥。浏览器不持久化密钥。
首次保存前可使用 `AI_*` 环境变量作为初始配置，保存后以数据库为准；明确移除不会再回退到环境变量密钥。

Pi 适配使用 [官方 Agent SDK](https://github.com/earendil-works/pi/tree/main/packages/agent)，每次调用为独立任务，支持取消和超时。
当前未给 Agent 开放 Shell 或文件修改工具。配置和连接测试不会读取用户的 Pi CLI 配置或全局凭据。

后台管理包含以下分区：

- 「媒体库」优先展示 `media` 表中已扫描或抓取到的媒体，可按标题 / 系列搜索、按类型筛选，查看封面、季集、来源（Bangumi / 豆瓣 / 本地扫描）、抓取与更新时间；展开详情可看简介、标签、来源信息和原始属性。整张表为空时自动回退显示磁盘扫描到的目录，标注为磁盘数据，便于确认哪些内容还没有入库。
- 「任务记录」展示 `task` 表的每次运行，支持按状态筛选，查看任务参数、执行结果与错误，取消排队中的任务，删除已结束的记录；有任务运行时自动刷新列表。
- 「定时任务」列出 `server/config/tasks.yaml` 注册的任务、cron、下次运行时间和运行状态，每行可「立即运行」手动触发，也可「重新加载配置」。
- 定时任务默认 `enabled: false`，不会按 cron 自动运行，只能手动触发；需要恢复自动调度时把对应任务的 `enabled` 改为 `true`，配置热加载后生效。

## 手柄支持

全部前端页面都可以只用手柄操作：接入手柄后自动进入「手柄模式」，当前选中项按主机游戏库的方式高亮
（描边 + 光晕 + 卡片放大），底部出现按键提示条。鼠标 / 键盘操作完全不受影响。

- 十字键 / 左摇杆：空间导航，自动跨海报墙、横向卡片行、剧集网格移动并滚动到可见区域；
- A 确认、B 返回、Start 打开「手柄设置」（顶栏的手柄图标也可打开），LB / RB 按页面切换媒体库 / 页签 / 上下集；
- 播放器：A 播放 / 暂停，← → 快退 / 快进（长按加速），↑ ↓ 音量，X 循环字幕，Y 打开控制台式「播放设置」
  （摇杆选择剧集 / 字幕 / 播放参数 / 页面跳转），B 关闭；
- 文本输入（登录密钥、搜索、后台配置）按 A 打开手柄虚拟键盘，支持字母、数字、符号、空格、退格、大写；
- 设置里可调死区、连发延迟与间隔、左右摇杆、反转 Y 轴、震动、提示条、隐藏指针，并逐项改键 + 实时按键测试；
  设置保存在浏览器 `localStorage['anishare.gamepad.v1']`。
- 手柄 API 需要安全上下文：**本机 `http://localhost` 可用；局域网 / 电视等设备请用 HTTPS 访问**（Firefox 强制，Chrome 可能屏蔽）。
  没有实体手柄时可在浏览器控制台执行 `__anishareGamepad.tap('down')` / `tap('confirm')` 验证交互。
- 实现与交互设计见 [手柄交互设计](docs/gamepad-design.md)，单元测试为 `web/test/gamepad.test.mjs`。

## 媒体助手

登录后（需要配置 `AUTH_SECRET` 并保存模型服务配置），页面右下角会出现悬浮按钮，点开即可与「媒体助手」对话。

- 对话通过同源 WebSocket `/api/agent/chat` 流式返回，界面会显示正在调用的工具；可随时停止本轮。
- 对话内容不写数据库，只保存在浏览器 `localStorage`（键 `anishare.agent.chat.v1`）；清除对话即删除本地数据，刷新或断线重连后仍可继续上下文。
- 助手可查询媒体库、作品详情、目录绑定、观看进度、任务记录与定时任务，并在明确要求时执行：抓取 Bangumi 条目、创建或修改影视记录、绑定目录并同步视频、触发扫描或定时任务、取消任务。
- 写操作只在明确要求时执行，没有删除类工具；未启用模型或未登录时，悬浮窗会提示前往「后台管理 → 模型服务」配置。
- 可选联网搜索：在「模型服务 → 联网搜索（DeepSeek）」保存 DeepSeek API Key（或勾选复用模型密钥）并启用后，助手会多出 `web_search` / `web_fetch` 工具，可查番剧资讯、播出信息等外部资料；网页内容按不可信数据处理。番剧整理 Agent 同样按需使用：Bangumi 搜不到时先联网确认标题/别名再重试，仍找不到就用文件夹名建待确认记录。**没有配置可用密钥时不会注册这两个工具。** 密钥单独加密保存在数据库，说明见 [联网搜索接入设计](docs/deepseek-search.md)。
- 协议、帧格式与本地存储结构见 [媒体助手 API](docs/chat-agent-api.md)，Agent 注册方式见 [Agent 架构](docs/agent-architecture.md)。

## 配置

后端模板见 [`server/.env.example`](server/.env.example)，由后端读取 `server/.env`。
前端独立使用 [`web/.env.example`](web/.env.example) 和 `web/.env`，不会读取后端的密钥配置。
根目录不再存放共享 `.env`。配置文件迁移不改变数据位置：相对的 `DATA_DIR`、`DB_PATH` 仍以项目根目录为基准，默认数据目录仍是项目根目录下的 `data/`。

前端配置：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WEB_PORT` | `6001` | 前端开发 / 预览端口，占用时直接报错 |
| `API_TARGET` | `http://127.0.0.1:8088` | Vite 开发 / 预览的后端代理地址，不写入浏览器代码 |

后端配置：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BANGUMI_LIBRARY` | `BANGUMI_ROOT` / `~/bangumi` | 番剧库目录 |
| `MOVIE_LIBRARY` | 空 | 电影库目录，不配置则不存在该库 |
| `HOST` / `PORT` | `0.0.0.0` / `8088` | 本地 API 监听地址与端口；Compose 中 PORT 是前端对外端口 |
| `AUTH_SECRET` | 空 | 单密钥登录，修改后重启，旧会话失效 |
| `SESSION_DAYS` | `30` | 会话有效天数 |
| `COOKIE_SECURE` | `0` | HTTPS 反向代理部署设为 `1` |
| `FRONTEND_ORIGINS` | 空 | 额外允许的前端 Origin，逗号分隔；同源代理不需要设置 |
| `DATA_DIR` | `./data` | 运行数据与配置加密密钥目录，相对项目根目录，默认不是 server/data |
| `DB_PATH` | `DATA_DIR/anishare.sqlite` | SQLite 文件，自动创建和迁移 |
| `TASKS_CONFIG` | `server/config/tasks.yaml` | 定时任务注册文件，修改后热加载；默认 `enabled: false` 只允许手动触发 |
| `AI_ENABLED` | `0` | 首次保存前的 Agent 启用状态 |
| `AI_API_FORMAT` | `openai-completions` | 初始模型 API 格式 |
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | 空 | 初始上游地址、模型、密钥 |
| `AI_MAX_TOKENS` / `AI_TIMEOUT_MS` | `2048` / `30000` | 初始输出上限与超时毫秒数 |
| `AI_CONFIG_KEY` | 空 | 可选的 32 字节 Base64 加密密钥；否则自动创建 `DATA_DIR/ai-config.key` |
| `DEEPSEEK_SEARCH_API_KEY` | 空 | 联网搜索密钥兜底；后台保存后以数据库 `ai-search` 行为准 |
| `AI_SEARCH_ENABLED` / `AI_SEARCH_BASE_URL` | `0` / `https://api.deepseek.com` | 联网搜索初始启用状态与接口根地址 |
| `AI_SEARCH_COUNT` / `AI_SEARCH_NEED_CONTENT` | `8` / `1` | 单次搜索条数（1–50）与是否返回网页正文 |
| `AI_SEARCH_TIMEOUT_MS` / `AI_SEARCH_REUSE_MODEL_KEY` | `15000` / `0` | 搜索超时与是否复用模型服务密钥 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 自动查找 | 自定义 ffmpeg / ffprobe 路径 |
| `TRANSCODE_VIDEO_CODEC` | 自动 | 编码器，例如 libx264 或 h264_nvenc |
| `TRANSCODE_VIDEO_BITRATE` | 源码率 | 如 4M、6M |
| `TRANSCODE_AUDIO_BITRATE` | `192k` | 音频码率 |
| `TRANSCODE_TONEMAP` | `1` | HDR → SDR 色调映射 |
| `HLS_SEGMENT_SECONDS` | `5` | HLS 分片秒数 |
| `HLS_IDLE_TIMEOUT_MS` | `300000` | 转码会话空闲回收时间 |
| `SUBTITLE_CACHE_MAX_MB` | `256` | 字幕 VTT 缓存目录上限，超出后按最久未用淘汰 |
| `SUBTITLE_EXTRACT_TIMEOUT_MS` | `1800000` | 单个内挂字幕提取的兜底超时毫秒数（需顺序读完整视频，慢速存储可调大） |

SQLite 保存会话、分库观看进度、模型配置和联网搜索配置（搜索密钥与模型密钥都用同一把 `ai-config.key` 加密，分属 `ai-config` / `ai-search` 两行）。旧数据库会自动迁移，浏览器旧观看记录会合并导入。
临时断网时进度保留在本地待同步；远程删除的历史不会被普通浏览器缓存重新导入。
备份时先停止 API，再同时备份 SQLite 和 `ai-config.key`；若使用 `AI_CONFIG_KEY`，同时保留该环境变量的值。

## Docker 双服务部署

从项目根目录执行以下命令；Compose 文件仍为根目录的 `docker-compose.yml`，配置从 `server/.env` 加载：

```bash
docker compose --env-file server/.env up -d --build --remove-orphans
docker compose --env-file server/.env logs -f server web
docker compose --env-file server/.env down
```

访问 `http://服务器地址:8088`，或者 `server/.env` 中配置的 `PORT`。本地直接启动时 `PORT` 是 API 端口，Compose 中则是前端对外发布的端口。
`web` 容器运行 Nginx，提供 Vue 页面并代理 `/api`；`server` 运行 Node API，不对外发布端口。
从旧单容器版本升级时，`--remove-orphans` 会移除旧服务容器并释放端口，已有 `anishare-data` 命名卷继续使用。
不要加 `down -v`，除非确实要清空观看历史、会话和 AI 配置。

多库需要挂载对应目录，并为每种库配置容器内路径：

```yaml
volumes:
  - /srv/anime:/media/anime:ro
  - /srv/films:/media/films:ro
  - anishare-data:/app/data
```

```dotenv
BANGUMI_LIBRARY=/media/anime
MOVIE_LIBRARY=/media/films
```

前端可独立执行 `docker build -f web/Dockerfile -t anishare-web .`；后端可独立执行 `docker build -t anishare-server .`。
自建前端托管时复用 `deploy/nginx.conf` 的 SPA、`/api`、`/assets/bangumi` 与 `/assets/local-media` 配置，并将 API 上游改为实际后端地址。封面由后端从 `DATA_DIR/bangumi` 和 `DATA_DIR/local-media` 提供，不能只代理 `/api`，否则媒体库表格和海报墙会显示首字占位图。

## HTTP API

| 接口 | 用途 |
| --- | --- |
| `GET /api/auth/session` | 登录状态 |
| `POST /api/auth/login` / `POST /api/auth/logout` | 密钥登录 / 注销 |
| `GET /api/status` | 媒体库、SQLite、ffmpeg 状态 |
| `GET /api/libraries` | 多库名称、可用状态和缓存数量，未知数量为 null |
| `GET /api/library?library=ID` | 指定库的海报列表，附带已绑定媒体的封面 / 标题和媒体数量 |
| `GET /api/library/series?library=ID&path=...` | 作品详情：绑定媒体、封面资料与按季剧集列表 |
| `GET /api/list?library=ID&path=...` | 文件目录 |
| `GET /api/video?library=ID&path=...` | 视频、同目录选集、字幕信息 |
| `GET/HEAD /api/stream` / `/api/file` | 带 Range 的媒体传输 |
| `GET /api/subtitle` / `/api/stream-subtitle` | 外挂 / 内挂字幕转 WebVTT；内挂首次为流式响应，结果按文件版本缓存在 `DATA_DIR/subtitles/` |
| `GET /api/hls/start?library=ID&path=...&t=0` | 创建转码会话 |
| `GET /api/hls/:id/index.m3u8` / `/seg/:name` / `/info` | 播放列表、分片、转码状态 |
| `DELETE /api/hls/:id` | 结束转码 |
| `GET/PUT/DELETE /api/progress` | 查询 / 保存 / 删除分库进度 |
| `POST /api/progress/import` | 合并旧记录，单次最多 500 条 |
| `GET/PUT /api/admin/ai/config` | 查询脱敏配置 / 保存模型配置 |
| `POST /api/admin/ai/test` | 测试草稿配置 |
| `GET/PUT /api/admin/ai/search` | 查询脱敏配置 / 保存联网搜索（DeepSeek）配置 |
| `POST /api/admin/ai/search/test` | 用草稿配置测试 DeepSeek 搜索连通性 |
| `POST /api/agent/run` | 使用已保存配置运行 Pi，正文 `{ "prompt": "..." }` |
| `WS /api/agent/chat` | 媒体助手多轮对话，帧协议见 [媒体助手 API](docs/chat-agent-api.md) |
| `GET /api/lib-folders` | 已扫描目录树与统计，详见 [扫描与定时任务 API](docs/scan-api.md) |
| `POST /api/libraries/:id/scan` | 手动触发扫描，返回任务 ID；`{ "force": true }` 忽略缓存重新分类所有目录 |
| `GET /api/tasks` / `GET /api/tasks/:id` | 任务记录列表 / 详情 |
| `POST /api/tasks/:id/cancel` / `DELETE /api/tasks/:id` | 取消排队任务 / 删除已结束任务 |
| `GET /api/scheduler/tasks` | 定时任务与下次运行时间 |
| `POST /api/scheduler/tasks/:type/run` | 立即触发一个定时任务 |
| `POST /api/scheduler/reload` | 重新读取 tasks.yaml |

媒体路径为相对所选库的虚拟路径，限制目录穿越、Windows 路径绕过和跨库软链接访问。
启用登录时，媒体、字幕、HLS、进度及后台接口均使用 HttpOnly Cookie 鉴权。

## 检查

```bash
npm --prefix server run typecheck   # tsc --noEmit，strict 模式
npm --prefix server run build       # 编译到 server/dist
npm --prefix server test            # Node 原生运行 .test.ts
npm --prefix web test
npm --prefix web run build
docker compose --env-file server/.env config --quiet
```

后端源码是 TypeScript：开发时 `node --watch src/index.ts` 直接跑（Node ≥ 22.19 的类型剥离），生产用 `npm run build` 编译到 `dist/`。Agent 的注册与扩展方式见 [Agent 架构](docs/agent-architecture.md)。

测试包含数据库升级、多库隔离、登录与 CSRF、Range / HEAD、API 与前端分离、AI 配置加密、草稿测试不保存，以及三个模型协议的真实 Pi SDK 本地模拟上游测试。
测试不需要真实模型 API Key，也不会调用付费模型服务。
