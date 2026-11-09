import type { AgentRunResult } from '../agent/types.ts'
import type { AiConfig } from '../types.ts'

const invalidPrompt = () => Object.assign(new Error('请输入 1 至 16000 个字符的 prompt，模型配置请在后台保存'), { status: 400, code: 'AI_PROMPT_INVALID' })

/** AI 配置的来源；只依赖 Agent 用到的两个方法。 */
export interface AgentSettingsSource {
  draft(draft?: unknown): AiConfig
  effective(): AiConfig
}

/** Pi Agent 运行器；配置在每次调用前由服务重新解析。 */
export type AgentRunner = (config: AiConfig, options: { prompt: string; signal?: AbortSignal }) => Promise<AgentRunResult>

export interface AgentTestResult {
  ok: true
  model: string
  apiFormat: string
  latencyMs: number
  reply: string
}

export interface AgentService {
  test(draft?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AgentTestResult>
  run(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AgentRunResult>
}

/** Select configuration and apply agent policy independently of HTTP transport. */
export function createAgentService(aiSettingsService: AgentSettingsSource, runPiAgent: AgentRunner): AgentService {
  return {
    async test(draft: Record<string, unknown> = {}, { signal }: { signal?: AbortSignal } = {}): Promise<AgentTestResult> {
      const config = aiSettingsService.draft(draft)
      const started = Date.now()
      const result = await runPiAgent({ ...config, maxTokens: 32 }, { prompt: '只回复 OK。', signal })
      return { ok: true, model: config.model, apiFormat: config.apiFormat, latencyMs: Date.now() - started, reply: result.text }
    },
    async run(body: Record<string, unknown>, { signal }: { signal?: AbortSignal } = {}): Promise<AgentRunResult> {
      if (!body || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000 || Object.keys(body).some((field) => field !== 'prompt')) {
        throw invalidPrompt()
      }
      return runPiAgent(aiSettingsService.effective(), { prompt: body.prompt.trim(), signal })
    },
  }
}
