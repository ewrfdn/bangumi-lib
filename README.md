# AniShare · 番剧库

内网番剧文件管理器 + 在线播放器。托管一个本地文件夹（默认 `~/bangumi`），
在浏览器里浏览、点开就播，支持 **H.264 / H.265(HEVC)** 与外挂 / 内挂字幕，**无需登录**。

```
┌──────────────┐   /api/*   ┌──────────────────────────┐
│  Vue 3 + Vite│ ─────────► │  Node.js (Fastify)       │
│  Artplayer   │            │  · 目录/番剧库 API        │
│  hls.js      │ ◄───────── │  · Range 直链流           │
└──────────────┘   HLS 分片  │  · ffmpeg 实时转码 + HLS 切片│
                            └──────────────────────────┘
```

## 特性

- **浏览**：番剧库首页（海报墙 / 继续观看 / 搜索）、文件夹视图（海报视图 / 列表视图、面包屑、筛选）
- **播放**：
  - H.264 / VP9 / AV1 + AAC 等浏览器原生支持的格式 → **直链播放**（Range 拖动，秒开）
  - H.265(HEVC) 10bit / MKV / DTS 等浏览器放不了的 → **服务端实时转码为 H.264**，通过 HLS 分片播放，进度条可拖动
  - 硬件编码自动探测（NVENC / VideoToolbox / VAAPI / QSV），不可用时自动回退 libx264
- **字幕**：
  - 外挂 `.ass/.ssa/.srt/.vtt`（自动匹配集数/文件名，GBK/BIG5 自动识别）→ 服务端转 WebVTT
  - 内挂字幕（MKV 内封 ASS/SUP 等）→ 按轨道列出，可切换
- **追番体验**：上一集/下一集、同目录选集、播放进度自动记录并续播
- **纯内网**：监听 `0.0.0.0`，无鉴权，手机/平板/电视盒子浏览器可直接访问

## 快速开始

```bash
# 1. 安装依赖（Node >= 20）
npm install

# 2. 配置媒体目录（复制模板后修改）
cp .env.example .env

# 3. （可选）安装项目自带的 ffmpeg（免 root，用于探测/转码/抽字幕）
npm run setup:ffmpeg      # 生成 tools/ffmpeg/bin/{ffmpeg,ffprobe}

# 4. 构建前端并启动
npm run build
npm start                 # 或用 pm2 / systemd 守护
```

启动后终端会打印所有可访问地址（如 `http://192.168.50.142:8088`）。

开发模式（前端热更新 + 后端 --watch）：

```bash
npm run dev               # 后端 :8088，前端 http://localhost:5173
```

## 配置（环境变量 / `.env`）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BANGUMI_ROOT` | `~/bangumi` | **要托管的媒体根目录**（也兼容 `MEDIA_ROOT`） |
| `HOST` | `0.0.0.0` | 监听地址（内网访问需要 0.0.0.0） |
| `PORT` | `8088` | 端口 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 自动查找 | 自定义 ffmpeg 路径（优先级：环境变量 > `tools/ffmpeg/bin` > PATH） |
| `TRANSCODE_VIDEO_CODEC` | 自动 | 强制指定编码器，如 `libx264`、`h264_nvenc`、`h264_videotoolbox` |
| `TRANSCODE_VIDEO_BITRATE` | 源码率 | 转码码率，如 `6M` |
| `TRANSCODE_AUDIO_BITRATE` | `192k` | 转码音频码率 |
| `TRANSCODE_TONEMAP` | `1` | HDR→SDR 色调映射开关（设 `0` 关闭） |
| `HLS_SEGMENT_SECONDS` | `5` | HLS 分片长度（秒） |
| `HLS_IDLE_TIMEOUT_MS` | `300000` | 转码会话空闲回收时间 |

`~/bangumi` 目录结构建议如下（也支持任意层级，文件浏览可以一层层点进去）：

```
~/bangumi/
└── 某番剧/
    ├── poster.jpg                  # 可选：封面图（poster/cover/folder/fanart 开头都行）
    └── Season 1/
        ├── [组名] 番剧名 - 01 [1080p][HEVC].mkv     # 内封字幕
        ├── 番剧名 01.chs.ass                        # 外挂字幕（按集数自动匹配）
        └── 番剧名 01.cht.ass
```

字幕匹配规则：同名/包含关系 → 集数相同（`S01E02` / 第2话 / `[02]`）→（目录里只有一个视频时）全部视为该视频字幕。

## 目录结构

```
anishare/
├── server/                 # Node 后端（Fastify，ESM）
│   └── src/
│       ├── index.js        # 启动、静态资源、SPA 回退
│       ├── config.js       # .env 加载与配置
│       ├── media.js        # 目录/番剧库扫描、字幕匹配、路径安全
│       ├── ffmpeg.js       # ffmpeg 探测、ffprobe、转码参数、字幕抽取
│       ├── hls.js          # TS→HLS 分段器（边转码边切片）+ 会话管理
│       └── routes.js       # HTTP API
├── web/                    # Vue 3 前端（Vite + Artplayer + hls.js）
│   └── src/
│       ├── views/{Home,Browse,Player}.vue
│       └── components/Poster.vue
├── scripts/
│   ├── dev.mjs             # 一键开发模式
│   └── install-ffmpeg.mjs  # 免 root 安装 ffmpeg（Ubuntu deb 重定位）
└── tools/ffmpeg/           # setup:ffmpeg 的产物（不入库）
```

## API 一览

| 接口 | 说明 |
| --- | --- |
| `GET /api/status` | 媒体目录、ffmpeg 路径、可用编码器 |
| `GET /api/library` | 番剧库总览（一部番剧一张卡片、封面、集数） |
| `GET /api/list?path=/` | 目录列表（虚拟路径，URL 编码） |
| `GET /api/video?path=...` | 视频信息：编码、时长、是否需转码、字幕列表、同目录选集 |
| `GET /api/stream?path=...` | 直链（支持 Range / HEAD） |
| `GET /api/subtitle?path=...` | 外挂字幕 → WebVTT |
| `GET /api/stream-subtitle?path=...&index=N` | 内挂字幕 → WebVTT |
| `GET /api/hls/start?path=...&t=0` | 创建（或复用）转码会话，返回 m3u8 地址 |
| `GET /api/hls/:id/index.m3u8` | 播放列表 |
| `GET /api/hls/:id/seg/:name` | 分片 |
| `DELETE /api/hls/:id` | 停止转码会话 |

路径参数都是相对媒体根目录的虚拟路径（`/番剧/Season 1/xxx.mkv` 的 URL 编码形式），
服务端会用 `path.resolve` 限制在根目录内，**禁止目录穿越**。

## 实现要点

- **为什么要转码**：浏览器 `<video>` / MSE 不支持 HEVC 解码。服务端用 ffmpeg 把 `HEVC → H.264`，
  以 5 秒左右一个关键帧切片，通过 HLS 喂给 hls.js；用户拖动到已生成过的位置可立即回放，
  拖到未生成的位置则从该点新建一个转码会话（`-ss` 在 `-i` 之前，秒级定位）。
- **分段器**（`server/src/hls.js`）：直接解析 ffmpeg 输出的 MPEG-TS 包，按视频 IDR 切片
  （处理了 mpegts 每包带 PES 头、NAL 跨包、CBR 填充伪造起始码、PTS 26.5 小时回绕等问题），
  `#EXT-X-PLAYLIST-TYPE:EVENT` 让 hls.js 可以在已缓存区间内原生拖动。
- **直链优先**：能原生播放的一律直链（Range），不浪费 CPU。
- **ffmpeg 可用性**：启动时用真实视频帧探测硬件编码器（GPU 被其他任务占用时会自动回退），
  某个源上硬件链路失败也会自动降级为软解软编。

## 常见问题

- **提示“无 ffmpeg”**：执行 `npm run setup:ffmpeg`，或 `export FFMPEG_PATH=/path/to/ffmpeg`。
- **H.265 卡顿**：默认码率跟源文件走。可调小 `TRANSCODE_VIDEO_BITRATE=4M`；
  有可用 GPU 时确认 `/api/status` 里 `transcode` 不是 `libx264`。
- **双击播放出现 2~3 秒黑屏**：转码首帧需要时间（`ffmpeg -ss` + 首个关键帧），属正常现象；已看过的剧集再次打开会更快（分片已缓存）。
- **图形字幕（sup/idx）**：无法以文本形式外挂，播放器会标注“图形字幕”。
- **开机自启**：用 systemd 示例即可：

```ini
# /etc/systemd/system/anishare.service
[Unit]
Description=AniShare
After=network.target

[Service]
WorkingDirectory=/home/sakana/workspace/anishare
ExecStart=/usr/bin/node server/src/index.js
Environment=BANGUMI_ROOT=/home/sakana/bangumi
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
