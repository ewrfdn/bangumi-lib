# 目录扫描与定时任务 API

扫描器把媒体库目录变成 `lib_folder` 记录，只有新增或变更的目录才会交给 Agent。
定时任务由 `server/config/tasks.yaml` 注册；默认 `enabled: false`，不会按 cron 自动运行，需要在后台管理「定时任务」中手动触发。

配置 `AUTH_SECRET` 时这些接口同样需要登录 Cookie；写请求沿用现有 Origin 检查。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/lib-folders` | 已扫描的目录树（扁平列表 + 统计） |
| `POST` | `/api/libraries/:libraryId/scan` | 手动触发一次扫描，返回任务 ID |
| `GET` | `/api/scheduler/tasks` | 定时任务列表、下次运行时间 |
| `POST` | `/api/scheduler/tasks/:type/run` | 立即触发一个已注册的定时任务 |
| `POST` | `/api/scheduler/reload` | 重新读取 tasks.yaml |

## 目录树

```http
GET /api/lib-folders?library=bangumi&includeMissing=0
```

```json
{
  "libraryId": "bangumi",
  "libraryName": "番剧库",
  "root": "/srv/bangumi",
  "includeMissing": false,
  "stats": { "failed": 1, "missing": 2, "scanned": 12 },
  "items": [
    {
      "id": 1, "parentId": null, "relPath": "", "name": "番剧库", "depth": 0,
      "status": "scanned", "mtimeMs": 1794142300340, "entryCount": 3,
      "scannedAt": 1794142300400, "error": null
    }
  ]
}
```

- `relPath` 相对媒体库根目录，根目录为空字符串，统一 `/` 分隔。
- `parentId` 为空表示根；据此可直接拼出树。
- `status`：`pending`（未扫描）、`scanned`（已处理）、`failed`（处理失败，下轮重试）、`missing`（磁盘上已不存在）。
- 默认隐藏 `missing` 及其整棵子树；`includeMissing=1` 才会返回。
- 不支持的查询参数返回 400，未知媒体库返回 404。

## 手动扫描

```http
POST /api/libraries/bangumi/scan
{"maxDepth": 4}
```

```json
{ "taskId": 42, "libraryId": "bangumi", "maxDepth": 4 }
```

- 立即返回 202，扫描在后台执行，用 `GET /api/tasks/42` 查看状态与结果。
- `maxDepth` 可选，0–10，默认 4。
- 同一媒体库同时只允许一个扫描，重复触发返回 409 `SCAN_RUNNING`。
- 扫描结果包含 `visited`、`changed`、`failed`、`missing`、`classified`、`synced`、`deferred`、`durationMs`。
- AI 未启用时，需要分类的目录记为 `failed` 并等待下次扫描，不会被误标为已处理。

## 定时任务

```http
GET /api/scheduler/tasks
```

```json
{
  "timezone": "Asia/Shanghai",
  "configPath": "/app/server/config/tasks.yaml",
  "tasks": [
    {
      "type": "scan_library",
      "cron": "0 */10 * * * *",
      "enabled": true,
      "options": { "libraryId": "bangumi", "maxDepth": 4 },
      "timeoutMs": 900000,
      "running": false,
      "nextRun": "2026-11-08T15:50:00.000Z"
    }
  ]
}
```

手动触发返回 202 与 `taskId`；任务已在运行返回 409；未注册类型返回 404。
`enabled: false` 的任务没有下次运行时间（`nextRun` 为 `null`），只能通过该接口或后台管理手动触发；把 `enabled` 改为 `true` 后热加载会恢复自动调度。

`POST /api/scheduler/reload` 重新读取 YAML：成功返回 `{ "ok": true }`，配置无效返回 422 并保留原调度。

## 配置文件

`server/config/tasks.yaml`，修改后自动热加载：

```yaml
timezone: Asia/Shanghai
tasks:
  - type: scan_library
    cron: "0 */10 * * * *"
    enabled: false   # false = 不自动触发，只能手动运行
    timeoutMs: 900000
    options:
      libraryId: bangumi
      maxDepth: 4
```

`type` 必须在 `server/src/scheduler/registry.ts` 注册；未知类型、非法 cron、拼错字段都会让启动失败，修改后的无效配置则保留上一份。

## 运行记录

每次调度或手动触发都会写一条 `task` 记录：

| 字段 | 内容 |
| --- | --- |
| `type` | 任务类型，例如 `scan_library` |
| `payload` | 本次使用的参数 |
| `status` | queued / running / succeeded / failed |
| `result` | 任务返回值，例如扫描摘要 |
| `error` | 失败摘要 |
| `startedAt / finishedAt` | 起止时间 |
