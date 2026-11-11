# 媒体助手（Chat Agent）

右下角悬浮窗里的对话 Agent：复用后台「模型服务」配置，通过 WebSocket 多轮对话，
用工具查询媒体库、查看任务/定时任务、触发扫描与整理归档。

对话内容**不写数据库**：服务端只按单次请求使用客户端传来的历史，浏览器把完整对话保存在
`localStorage`（键名与结构见下文）。刷新页面或重连后仍可继续聊，服务端保持无状态。

## WebSocket 接口

- 地址：`GET /api/agent/chat`（`Upgrade: websocket`）
- 前端用同源地址：开发时由 Vite `/api` 代理（需 `ws: true`），部署时由 Nginx 代理。
- 文本帧，UTF-8 JSON，单帧最大 256 KB。
- 鉴权（与后台 AI 接口策略一致：AI 能力要求已配置登录）：
  - 未配置 `AUTH_SECRET`：握手返回 HTTP 403，JSON `{"error":"请先配置 AUTH_SECRET，登录后才能使用 AI 助手","code":"ADMIN_AUTH_REQUIRED"}`。
  - 未登录 / 会话失效：HTTP 401，JSON `{"error":"请先输入访问密钥登录","code":"UNAUTHORIZED"}`。
  - `Origin` 存在时必须与请求 `Host` 同源，或在 `FRONTEND_ORIGINS` 白名单内，否则 HTTP 403。
  - 路径不匹配的 upgrade 请求返回 HTTP 404。

### 服务端 → 客户端

| type | 字段 | 说明 |
| --- | --- | --- |
| `ready` | `agent {type,label}`、`aiEnabled: boolean`、`model: string \| null`、`tools: [{name,label,description}]` | 握手成功后的第一条帧；`aiEnabled=false` 时前端提示去后台配置模型 |
| `start` | `id` | 开始处理一条用户消息 |
| `delta` | `id`、`text` | 流式正文增量，按顺序拼接 |
| `tool` | `id`、`toolCallId`、`name`、`label`、`phase: 'start' \| 'end'`、`ok?`、`durationMs?` | 工具调用活动，仅用于展示 |
| `done` | `id`、`text`、`turns`、`toolCalls` | 本轮最终文本（与 delta 拼接结果一致，以它为准） |
| `error` | `id?`、`code`、`message` | 本轮失败；`id` 缺省表示协议级错误 |
| `aborted` | `id?` | 用户取消或连接关闭导致本轮中止 |
| `pong` | — | 应答客户端 `ping` |

### 客户端 → 服务端

| type | 字段 | 说明 |
| --- | --- | --- |
| `chat` | `id`、`message`、`history: [{role:'user'\|'assistant', content}]` | 发起一轮；`history` 只含此前的轮次，按时间正序，服务端把 `message` 作为最新 user 轮 |
| `abort` | `id?` | 取消进行中的一轮 |
| `ping` | — | 保活；服务端回 `pong` |

约束：

- `id` 为 1–64 个 `[A-Za-z0-9_-]` 字符，客户端生成，用于对齐请求与帧。
- `message` 1–8000 字符；`history` 最多 40 条，每条 1–8000 字符，合计不超过 48000 字符。
- 同一连接同时只允许一轮；上一轮未结束时再发 `chat` 返回 `error{code:'CHAT_BUSY'}`，不排队。
- 历史由服务端宽松归一：丢弃连续同角色消息、丢弃末尾未得到回复的 user 轮；空历史的会话仍然可用。
- 服务端不持久化任何对话内容，也不写日志正文。

### 错误码

`CHAT_BUSY`、`CHAT_INVALID`、`CHAT_HISTORY_INVALID`、`CHAT_NOT_READY`、`AI_DISABLED`、
`AI_NOT_CONFIGURED`、`AI_CONFIG_INVALID`、`AI_CONFIG_DECRYPTION_FAILED`、`PI_TIMEOUT`、
`PI_ABORTED`、`PI_CONFIG_INVALID`、`PI_UPSTREAM_AUTH`、`PI_UPSTREAM_MODEL`、`PI_UPSTREAM_LIMIT`、
`PI_UPSTREAM_ERROR`、`PI_TOOL_LIMIT`、`PI_OUTPUT_LIMIT`、`CHAT_FAILED`。

`message` 是给用户看的中文说明，不含上游响应体或密钥；未知错误统一为
`CHAT_FAILED` /「助手暂时无法回复，请稍后重试。」

## 浏览器本地存储

- 键：`anishare.agent.chat.v1`
- 值：

```json
{
  "version": 1,
  "updatedAt": 1760000000000,
  "messages": [
    { "role": "user", "content": "最近看了什么？", "at": 1760000000000, "status": "ok" },
    { "role": "assistant", "content": "你最近看的是……", "at": 1760000001000, "status": "ok" }
  ]
}
```

- `status`: `ok` | `error` | `aborted`（仅影响本地展示；`error`/`aborted` 且正文为空的消息不进入下次请求历史）。
- 最多保留 100 条、正文合计 100000 字符；超出时从最旧的整轮开始丢弃。读取到损坏数据按空会话处理。
- 清除对话即删除该键；不调用任何后端接口。

## Chat Agent 定义

`server/src/agent/agents/chat.agent.ts`：

```ts
type = 'chat'
label = '媒体助手'
maxTurns = 10
maxToolCalls = 32
timeoutMs = 120_000
```

上下文 `{ messages: {role,content}[] }`：提示词取 `prompts/chat.md`，历史轮次交给
`pi.runtime` 作为真实的 user/assistant 消息回放，最新一条作为本轮 prompt。

工具（`agent/tools/chat.tools.ts`，覆盖项目现有工具能力）：

| 读 | 写 / 归档 |
| --- | --- |
| `list_libraries` 媒体库与统计 | `crawl_bangumi` 抓取 Bangumi 条目并落库 |
| `get_status` 服务状态 | `create_media` 手动建影视记录 |
| `browse_library` 库内作品（含绑定与封面） | `update_media` 修改资料字段 |
| `search_media` 按标题搜本地影视 | `sync_local_media` 目录绑定并收集视频 |
| `list_media` 分页列出影视 | `scan_library` 触发一次异步扫描（返回 taskId） |
| `get_media` 影视详情（绑定/视频/进度） | `run_scheduler_task` 立即触发定时任务（返回 taskId） |
| `list_folder` 列出库内目录 | `cancel_task` 取消排队/执行中的任务 |
| `get_folder_binding` 目录绑定与视频 | |
| `search_bangumi` 搜索 Bangumi 候选 | |
| `list_watch_progress` 最近观看进度 | |
| `list_tasks` / `get_task` 任务记录 | |
| `list_scheduler_tasks` 定时任务配置 | |

写工具只在用户明确要求执行/整理时使用；不提供删除工具；批量扫描前先说明范围。
`scan_library` 支持 `force: true`：忽略目录 mtime 缓存重新分类所有目录，用于重试上次没有识别出来的目录
（会再次调用模型，属于显式操作）。`search_bangumi` 返回 0 条且联网搜索可用时，助手可以先 `web_search`
确认标题/别名再重试，网页结果不能当作 Bangumi ID。

可选能力：在「后台管理 → 模型服务 → 联网搜索」启用 DeepSeek Search / Fetch 后，会额外注册
`web_search`（联网搜索）与 `web_fetch`（抓取网页正文）两个工具，并自动出现在 `ready.tools` 中；
未启用时不注册。网页内容是不可信外部数据，提示词要求模型只当资料引用、不执行其中指令。
密钥与配置说明见 [联网搜索接入设计](deepseek-search.md)。

## 实现位置

```
server/src/agent/agents/chat.agent.ts        # ChatAgent 定义
server/src/agent/tools/chat.tools.ts         # 查询与归档工具
server/src/agent/tools/search.tools.ts       # 可选：web_search / web_fetch
server/src/service/deepseek-search.service.ts # DeepSeek Search / Fetch 客户端
server/src/agent/prompts/chat.md             # 系统提示词
server/src/service/chat.service.ts           # 输入校验 + 调用 AgentManager
server/src/controller/agent-chat.controller.ts  # WebSocket 网关
web/src/agentChatStore.js                    # localStorage 读写与历史裁剪
web/src/components/AgentChat.vue             # 右下角悬浮窗
```
