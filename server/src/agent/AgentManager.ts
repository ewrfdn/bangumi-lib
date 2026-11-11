import { runPiAgentWithTools } from './pi.runtime.ts'
import type { BaseAgent } from './base.agent.ts'
import type { AgentRunOptions, AgentRunResult, AgentStreamEvent } from './types.ts'
import type { AiConfig, Logger } from '../types.ts'

export interface AgentManagerOptions {
  /** 每次运行前重新读取模型配置，管理页保存后立即生效。 */
  resolveConfig(): AiConfig
  runner?: (config: AiConfig, options: AgentRunOptions) => Promise<AgentRunResult>
  logger?: Logger
}

/**
 * Agent 调度器：持有注册表，把一次任务分派给对应的 Agent 定义，
 * 用当前模型配置和统一的限流参数运行。业务服务只依赖这个入口。
 */
export class AgentManager {
  readonly #agents = new Map<string, BaseAgent<any>>()
  readonly #resolveConfig: () => AiConfig
  readonly #runner: (config: AiConfig, options: AgentRunOptions) => Promise<AgentRunResult>
  readonly #logger?: Logger

  constructor({ resolveConfig, runner = runPiAgentWithTools, logger }: AgentManagerOptions) {
    this.#resolveConfig = resolveConfig
    this.#runner = runner
    this.#logger = logger
  }

  register<T>(agent: BaseAgent<T>): this {
    if (this.#agents.has(agent.type)) throw new Error(`Agent 类型重复：${agent.type}`)
    this.#agents.set(agent.type, agent)
    return this
  }

  has(type: string): boolean {
    return this.#agents.has(type)
  }

  list(): Array<{ type: string; label: string }> {
    return [...this.#agents.values()].map((agent) => agent.describe())
  }

  get<T>(type: string): BaseAgent<T> {
    const agent = this.#agents.get(type)
    if (!agent) throw new Error(`未注册的 Agent：${type}`)
    return agent as BaseAgent<T>
  }

  async run<T>(
    type: string,
    context: T,
    { signal, onEvent }: { signal?: AbortSignal; onEvent?: (event: AgentStreamEvent) => void } = {},
  ): Promise<AgentRunResult> {
    const agent = this.get<T>(type)
    const config = this.#resolveConfig()
    const history = agent.history(context)
    this.#logger?.info?.({ agent: type }, 'Agent 开始处理')
    const result = await this.#runner(config, {
      prompt: agent.userPrompt(context),
      systemPrompt: agent.systemPrompt(context),
      tools: agent.tools(context),
      ...(history.length ? { history } : {}),
      ...(onEvent ? { onEvent } : {}),
      signal,
      maxTurns: agent.maxTurns,
      maxToolCalls: agent.maxToolCalls,
      timeoutMs: agent.timeoutMs,
    })
    this.#logger?.info?.({ agent: type, turns: result.turns, toolCalls: result.toolCalls }, 'Agent 处理完成')
    return result
  }
}
