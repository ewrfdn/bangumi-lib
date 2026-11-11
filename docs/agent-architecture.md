# Agent 架构

扫描器只负责发现「目录变了」，判断和登记交给 Agent。Agent 的定义、调度和模型调用分成三层，互不耦合。

## 目录

```
server/src/agent/
├── AgentManager.ts          # 调度器：注册表 + 运行 + 日志
├── base.agent.ts            # 基类：类型、提示词、工具、历史、限流参数
├── agents/
│   ├── bangumi.agent.ts     # 番剧整理
│   └── chat.agent.ts        # 媒体助手（对话型）
├── pi.runtime.ts            # Pi SDK 适配：模型、鉴权、工具循环、历史回放、流式事件
├── types.ts                 # AgentTool / AgentRunOptions / AgentRunResult
├── tools/
│   ├── media-scan.tools.ts  # 媒体扫描读写工具
│   ├── chat.tools.ts        # 媒体助手查询与归档工具
│   ├── search.tools.ts      # 可选：web_search / web_fetch（DeepSeek Search）
│   └── tool-kit.ts          # 工具 schema、结果与路径解析助手
└── prompts/
    ├── media-scan.md        # 番剧整理系统提示词
    └── chat.md              # 媒体助手系统提示词
```

对话型 Agent 的传输层在 `controller/agent-chat.controller.ts`（WebSocket 网关），
入参校验与调用在 `service/chat.service.ts`；协议见 [chat-agent-api.md](chat-agent-api.md)。

## 三层职责

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| `BaseAgent` 子类 | 这个 Agent 是什么：系统提示词、用户提示词、可用工具、预算 | 模型配置、HTTP、重试 |
| `AgentManager` | 注册表、按 `type` 分派、取当前模型配置、统一日志 | 业务判断、写库 |
| `pi.runtime` | Pi SDK 的模型/提供商/鉴权适配，单轮与工具循环 | 任何业务语义 |

服务层只依赖 `AgentManager.run(type, context)`，不关心底层用的是哪家模型、走什么协议。

## 基类契约

```ts
export abstract class BaseAgent<TContext = unknown> {
  abstract readonly type: string        // 注册名，如 'bangumi'
  abstract readonly label: string       // 展示名
  readonly maxTurns = 8                 // 对话轮数上限
  readonly maxToolCalls = 24            // 工具调用上限
  readonly timeoutMs = 120_000          // 单次运行预算

  abstract systemPrompt(context: TContext): string
  abstract userPrompt(context: TContext): string
  abstract tools(context: TContext): AgentTool[]

  history(context: TContext): AgentConversationTurn[]  // 可选覆盖，对话型 Agent 回放历史轮次
  protected promptFile(name: string): string  // 读取并缓存 prompts/ 下的文件
}
```

提示词和工具都按 **context** 构建，所以同一个 Agent 实例可以并发处理不同目录，不需要请求级状态。
`history` 默认返回空数组，一次性任务的子类无需实现。

## AgentManager

```ts
const agents = new AgentManager({
  resolveConfig: () => aiSettings.effective(),  // 每次运行重新取，管理页保存后立即生效
  runner: runPiAgentWithTools,                  // 测试时可以替换
  logger: app.log,
})
agents.register(new BangumiAgent({ services, models, mediaSync }))

await agents.run('bangumi', { library, folder, entries, binding, signal })
await agents.run('chat', { messages }, { signal, onEvent })  // 对话型：历史由 history() 提供，事件流式回传
```

- `resolveConfig` 在每次运行前调用，配置热更新不需要重建 manager。
- `register` 拒绝重复 `type`；`run` 对未注册类型直接抛错，不会静默跳过。
- 运行结果 `{ text, turns, toolCalls, stopReason }` 只用于日志和摘要，**不落库**；落库全部由工具完成。
- `onEvent` 是可选展示通道（`delta` / `tool_start` / `tool_end`），只服务 WebSocket UI，不参与业务判断。

## 番剧整理 Agent

`BangumiAgent` 的上下文：

```ts
{
  library: Library            // 哪个库、根目录
  folder: LibFolder           // 哪个目录、深度、上次扫描状态
  entries: { total, truncated, items }  // 一级子项快照
  binding: LocalMedia | null  // 目录是否已绑定影视
  signal?: AbortSignal
}
```

流程：

1. `scan.service` 发现目录变化，先查绑定；已绑定且影视有 `data_source` 就直接同步视频，不调模型。
2. 其余目录交给 `agents.run('bangumi', context)`。
3. 模型通过工具查询、搜索、抓取、写库，最后必须调用一次 `report` 结束本轮。
4. 扫描器根据 `report` 的 `kind` 记录结果；失败则保留 `failed` 状态等待下次重试。

工具清单见 [scan-scheduler-design.md](scan-scheduler-design.md#7-agent-工具)。

## 媒体助手 Agent（对话型）

`ChatAgent`（`type = 'chat'`，展示名「媒体助手」）是唯一的多轮对话 Agent，入口是
`WS /api/agent/chat`，由右下角悬浮窗使用。它和一次性任务共用同一套 `AgentManager`、
模型配置与工具约定，区别有三点：

1. **上下文**：`{ messages: { role, content }[] }`，最新一条用户消息是 `userPrompt`，
   更早的轮次由 `history(context)` 返回，运行时作为真实的 user / assistant 消息回放。
2. **不落库**：对话只存在于浏览器 `localStorage`，每次请求由客户端带上历史；
   服务端不写数据库、不写日志正文，连接断开即释放。
3. **流式输出**：`AgentManager.run(type, context, { signal, onEvent })` 把
   `text_delta`、`tool_execution_start/end` 转成 `delta` / `tool_start` / `tool_end`
   事件，WebSocket 网关逐帧转发；`onEvent` 回调抛错被吞掉，不影响 Agent 运行。

工具（`chat.tools.ts`，20 个）覆盖项目现有能力：媒体库与作品查询、目录浏览与绑定、
本地影视搜索、观看进度、任务与定时任务查询，以及抓取 Bangumi、建/改影视、绑定目录、
触发扫描或定时任务、取消任务等写操作；不提供删除工具。写操作由系统提示词约束为
「仅在用户明确要求时执行」，批量扫描前先说明范围。

可选能力：后台「模型服务 → 联网搜索」启用且配置了可用密钥后，`ChatAgent.tools()` 与
`BangumiAgent.tools()` 都会追加 `web_search` / `web_fetch` 两个工具（`search.tools.ts`），
未启用或没有密钥时不注册。番剧整理 Agent 把它用作 Bangumi 搜不到时的按需补强。
详见 [联网搜索接入设计](deepseek-search.md)。

历史回放上限：40 轮、每条 8000 字符、合计 48000 字符；`chat.service` 先做宽松归一
（丢弃连续同角色、去掉末尾未回复的 user 轮），`pi.runtime` 再做硬校验，超出时返回
`PI_HISTORY_INVALID` 且不会发出上游请求。

## 运行时约束

以电影库为例：

```ts
export class MovieAgent extends BaseAgent<MovieContext> {
  readonly type = 'movie'
  readonly label = '电影整理'
  readonly maxTurns = 6

  systemPrompt() { return this.promptFile('movie-scan.md') }
  userPrompt(ctx: MovieContext) { return `...${JSON.stringify(ctx)}` }
  tools(ctx: MovieContext) { return createMovieTools(ctx) }
}
```

然后在 `app.ts` 注册：

```ts
services.agentManager.register(new MovieAgent({ services, models }))
```

调度器或其他服务用 `agents.run('movie', context)` 调用即可。不需要改 `AgentManager` 或 `pi.runtime`。

## 运行时约束

| 限制 | 值 | 实现 |
| --- | --- | --- |
| 工具调用 | 24 次 | `runPiAgentWithTools` 包装每个工具 |
| 对话轮数 | 8 轮 | `finishTurn` 返回 `end` |
| 总耗时 | 120 秒 | `AbortController` + 定时器 |

超出限制的调用会抛 `PI_TOOL_LIMIT` / `PI_TIMEOUT`，扫描器把目录记为 `failed`，下次扫描重试。工具内部抛出的 `HttpError` 会转成错误结果喂回模型，不会直接中断整轮。
