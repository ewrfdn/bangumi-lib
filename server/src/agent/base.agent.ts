import fs from 'node:fs'
import type { AgentTool } from './types.ts'

const PROMPT_DIR = new URL('./prompts/', import.meta.url)
const promptCache = new Map<string, string>()

/**
 * Agent 基类：子类只声明类型、提示词和工具，运行、限流、记录由 AgentManager 负责。
 * 提示词与工具都按上下文构建，同一进程内可以并发处理不同目录。
 */
export abstract class BaseAgent<TContext = unknown> {
  abstract readonly type: string
  abstract readonly label: string

  /** 单次运行的对话轮数上限。 */
  readonly maxTurns: number = 8
  /** 单次运行的工具调用上限。 */
  readonly maxToolCalls: number = 24
  /** 单次运行的总体时间预算，毫秒。 */
  readonly timeoutMs: number = 120_000

  abstract systemPrompt(context: TContext): string

  abstract userPrompt(context: TContext): string

  abstract tools(context: TContext): AgentTool[]

  /** 读取 prompts/ 下的提示词；随代码发布，首次使用后缓存。 */
  protected promptFile(name: string): string {
    const cached = promptCache.get(name)
    if (cached !== undefined) return cached
    const content = fs.readFileSync(new URL(name, PROMPT_DIR), 'utf8')
    promptCache.set(name, content)
    return content
  }

  describe(): { type: string; label: string } {
    return { type: this.type, label: this.label }
  }
}
