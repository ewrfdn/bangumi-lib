# 影视库 SQLite API

这批接口查询 SQLite，按已确认的 `media / local_media / local_media_video / media_tracks / task` 结构实现。
启动后自动升级到 v7，保留旧观看进度、登录会话和加密模型配置。
配置 `AUTH_SECRET` 时所有接口需要现有登录 Cookie；写请求沿用现有 Origin 检查。

## 接口

| 资源 | 列表 / 新增 | 读取 / 更新 / 删除 |
| --- | --- | --- |
| 影视 | `GET /api/media`、`POST /api/media` | `GET/PATCH/DELETE /api/media/:id` |
| 本地目录 | `GET /api/local-media`、`POST /api/local-media` | `GET/PATCH/DELETE /api/local-media/:id` |
| 本地视频 | `GET /api/local-media-videos`、`POST /api/local-media-videos` | `GET/PATCH/DELETE /api/local-media-videos/:id` |
| 观看历史 | `GET /api/media-tracks` | `GET/PUT/DELETE /api/media-tracks/:mediaId/:videoIndex` |
| 通用任务 | `GET /api/tasks`、`POST /api/tasks` | `GET/DELETE /api/tasks/:id`、`POST /api/tasks/:id/cancel` |

新增资源返回 201，读取和修改返回 `{ "item": ... }`；删除返回 `{ "ok": true }`。
列表返回 `{ "items": [], "total": 0, "limit": 50, "offset": 0 }`，`limit` 最大 200。
错误状态：输入无效 400，未登录 401，跨站写入 403，不存在 404，引用冲突 / 重复记录 / 任务状态冲突 409。
字段使用 camelCase，对应数据库 snake_case；不支持的字段和查询参数会被拒绝。

## 入库示例

`POST /api/media`：

```json
{
  "title": "示例番剧 第一季",
  "mediaType": "anime",
  "dataSource": "Bangumi",
  "dataSourceUrl": "https://bgm.tv/subject/123",
  "season": 1,
  "episodeCount": 12,
  "tags": ["科幻"],
  "attribute": { "sourceId": "example" },
  "series": "示例番剧"
}
```

影视还支持 `cover`、`description`、`rating`、`airedOn`。季号和集数是整数；评分 0–10 或 null。
`dataSource` 和 `dataSourceUrl` 支持新增、读取与 PATCH 更新；默认 null，可传 null 清除。来源链接仅保存为元数据，不自动请求该地址。
可空字段以 null 清除，`attribute` 是 JSON 对象，`tags` 是字符串数组。
`GET /api/media` 支持 `q`（标题 / 系列包含搜索）、`mediaType`、`series`。

`POST /api/local-media`：

```json
{ "libraryId": "default", "folderPath": "示例番剧/第一季", "mediaId": 1 }
```

`libraryId` 必须在服务端已配置的媒体库中，缺省使用默认库。
`folderName` 可填写，缺省使用目录末段；`folderHash` 由 Service 计算，客户端不能指定。
目录路径相对于库根路径，空字符串表示根目录。`GET` 支持 `libraryId`、`mediaId`、`q`。
文件夹根路径仍由 `server/.env` 中的多库配置管理。

`POST /api/local-media-videos`：

```json
{
  "localMediaId": 1,
  "mediaPath": "第01集.mkv",
  "videoIndex": 1,
  "videoType": "main",
  "durationMs": 1440000,
  "width": 1920,
  "height": 1080,
  "frameCount": 34560
}
```

`mediaId` 由目录推导；显式提供时必须与目录一致。`title` 缺省取文件名。
可填写 `coverPath`、`sizeBytes`、`mtimeMs`、`width`、`height`、`frameCount`、`missing`。`mediaPath` 相对于本地目录，允许子目录，拒绝绝对路径及目录穿越。
扫描已绑定目录时会抽取视频中间帧生成 480p JPEG，`coverPath` 保存为相对 `DATA_DIR` 的 `local-media/<localMediaId>/<hash>.jpg`，通过 `/assets/local-media/...` 提供；生成失败时保持可空。
扫描同时用 ffprobe 写入 `durationMs`、`width`、`height`、`frameCount`，便于归档和人工核对片源；已有且未变化的视频不重复探测。
`videoType` 由扫描根据媒体的 Bangumi `episodeCount` 自动判定：集号为 1..总集数的整数且在正片目录中的视频为 `main`；`特典/SP/PV/CM/NCOP/NCED` 等目录、超出总集数或 11.5 这类非整数集号为 `extra`。番外建议使用 `12.5` 这类排在本季之后的 `videoIndex`；Agent 可用 `update_videos` 工具修正自动分类。不同内容不能使用同一影视和集号。
`GET` 支持 `mediaId`、`localMediaId`、`videoType`、`missing=true/false` 和 `q`。
这些接口仅保存 / 删除索引记录，不读取、移动或删除磁盘上的视频文件；实际播放时仍需校验文件路径。

## 观看历史

`PUT /api/media-tracks/1/1`：

```json
{ "positionMs": 120000, "durationMs": 1440000, "completed": false }
```

`positionMs` 必填。联合主键为 `mediaId + videoIndex`，没有独立 id / videoId；相同集号的多个文件版本共享进度。
Service 校验对应影视及集号确实存在于视频表；数据库外键保护影视引用。
可传 `watchedAt` 以同步离线记录，不传使用服务端时间；旧时间记录不覆盖更新的观看进度。
历史列表支持 `mediaId`，按最近观看时间排序；该接口返回 no-store。
视频被标记 missing 或索引文件记录被移除时，历史保留。旧 `/api/progress` 仍独立工作，尚未自动迁移到这张表。

## 通用任务

`POST /api/tasks`：

```json
{ "type": "download_video", "payload": { "mediaId": 1, "source": "example" }, "runAfter": 0 }
```

任务类型可使用 scan_library / download_video / fetch_metadata 等，输入输出 JSON 最大 64 KB。
调用方应在 payload 中引用配置，不放 API Key。`GET` 支持 `type`、`status` 和分页。
新任务为 queued；可取消 queued / running 任务，已结束任务不可再次开始。
删除任务前需结束或取消；取消 running 任务表示状态已取消，未来执行器需要在检查点配合停止。

Service 向后端执行器提供 `claimNext()`、`progress(id, value)`、`complete(id, result)`、`fail(id, error)`。
`claimNext` 在 SQLite 写事务内领取到期任务，防止不同 worker 重复领取；结束操作校验任务仍在 running。
这些执行方法不暴露为 HTTP 接口。当前未启动执行器，排队记录不会自动扫描或下载。

## 代码位置

- `server/src/model/database.js`：连接和版本迁移，向 Service 提供 `database.catalog`。
- `server/src/model/catalog.model.js`：5 张业务表的 SQL、JSON 映射、分页和任务领取事务。
- `server/src/service/catalog.service.js`、`local-media.service.js`、`local-media-video.service.js`、`media-tracks.service.js`、`task.service.js`：对应业务逻辑。
- `server/src/controller/`：同名 Controller；`app.js` 组装依赖，`routes.js` 注册接口。
