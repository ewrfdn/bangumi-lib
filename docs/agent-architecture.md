# Agent 架构

扫描器只负责发现「目录变了」，判断和登记交给 Agent。Agent 的定义、调度和模型调用分成三层，互不耦合。

## 目录

```
server/src/agent/
├── AgentManager.ts          # 调度器：注册表 + 运行 + 日志
├── base.agent.ts            # 基类：类型、提示词、工具、限流参数
├── agents/
│   └── bangumi.agent.ts     # 番剧整理（目前唯一的业务 Agent）
├── pi.runtime.ts            # Pi SDK 适配：模型、鉴权、工具循环
├── types.ts                 # AgentTool / AgentRunResult
├── tools/
│   └── media-scan.tools.ts  # 媒体库读写工具
└── prompts/
    └── media-scan.md        # 系统提示词
```

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

  protected promptFile(name: string): string  // 读取并缓存 prompts/ 下的文件
}
```

提示词和工具都按 **context** 构建，所以同一个 Agent 实例可以并发处理不同目录，不需要请求级状态。

## AgentManager

```ts
const agents = new AgentManager({
  resolveConfig: () => aiSettings.effective(),  // 每次运行重新取，管理页保存后立即生效
  runner: runPiAgentWithTools,                  // 测试时可以替换
  logger: app.log,
})
agents.register(new BangumiAgent({ services, models, mediaSync }))

await agents.run('bangumi', { library, folder, entries, binding, signal })
```

- `resolveConfig` 在每次运行前调用，配置热更新不需要重建 manager。
- `register` 拒绝重复 `type`；`run` 对未注册类型直接抛错，不会静默跳过。
- 运行结果 `{ text, turns, toolCalls, stopReason }` 只用于日志和摘要，**不落库**；落库全部由工具完成。

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

## 新增一个 Agent

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
