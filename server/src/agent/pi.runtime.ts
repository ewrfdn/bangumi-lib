import { Agent } from '@earendil-works/pi-agent-core'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import type { AiConfig } from '../types.ts'
import type { AgentConversationTurn, AgentRunOptions, AgentRunResult, AgentStreamEvent } from './types.ts'

const API_FACTORIES: Record<string, () => unknown> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
}
const PROVIDER_ID = 'anishare-configured'

/** 对话型 Agent 每次请求可回放的历史上限；与 Chat Service 的入参校验保持一致。 */
export const HISTORY_MAX_TURNS = 40
export const HISTORY_MAX_CHARS = 48_000
export const HISTORY_TURN_MAX_CHARS = 8_000

const seededUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * 把历史轮次还原成 SDK 能理解的 user/assistant 消息。
 * 只回放已结束的轮次；最新一条用户消息始终走 `prompt()`，避免与系统提示词顺序冲突。
 */
function seededHistory(config: AiConfig, history: AgentConversationTurn[] | undefined): any[] {
  if (history === undefined) return []
  if (!Array.isArray(history) || history.length > HISTORY_MAX_TURNS) {
    throw agentError('PI_HISTORY_INVALID', '对话历史过长，请先清空对话。', 400)
  }
  let total = 0
  return history.map((turn) => {
    const content = turn && typeof turn.content === 'string' ? turn.content.trim() : ''
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant') || !content || content.length > HISTORY_TURN_MAX_CHARS) {
      throw agentError('PI_HISTORY_INVALID', '对话历史格式无效，请先清空对话。', 400)
    }
    total += content.length
    if (total > HISTORY_MAX_CHARS) throw agentError('PI_HISTORY_INVALID', '对话历史过长，请先清空对话。', 400)
    const timestamp = Date.now()
    if (turn.role === 'user') return { role: 'user', content, timestamp }
    return {
      role: 'assistant', content: [{ type: 'text', text: content }], api: config.apiFormat,
      provider: PROVIDER_ID, model: config.model, usage: seededUsage, stopReason: 'stop', timestamp,
    }
  })
}

export interface AgentError extends Error {
  code: string
  statusCode: number
}

function agentError(code: string, message: string, statusCode = 502): AgentError {
  return Object.assign(new Error(message), { code, statusCode })
}

export interface PiRuntime {
  models: any
  model: any
  sdkKey: string
  fetch: typeof fetch
  maxTokens: number
  timeoutMs: number
  apiFormat: string
}

function validateConfig(config: AiConfig): { factory: () => unknown; baseUrl: string; apiKey: string; maxTokens: number; timeoutMs: number } {
  const factory = Object.hasOwn(API_FACTORIES, config?.apiFormat) ? API_FACTORIES[config.apiFormat] : null
  let endpoint: URL | undefined
  try { endpoint = new URL(config?.baseUrl) } catch { /* Validated below. */ }
  if (!factory || !endpoint || !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      typeof config.model !== 'string' || !config.model.trim() || config.model.length > 300 ||
      (config.apiKey !== undefined && typeof config.apiKey !== 'string')) {
    throw agentError('PI_CONFIG_INVALID', '模型接口配置无效，请检查接口格式、地址和模型名称。', 400)
  }
  const maxTokens = config.maxTokens ?? 2048
  const timeoutMs = config.timeoutMs ?? 30000
  if (!Number.isInteger(maxTokens) || maxTokens < 1 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000) {
    throw agentError('PI_CONFIG_INVALID', '模型输出上限或请求超时时间无效。', 400)
  }
  return { factory, baseUrl: config.baseUrl.replace(/\/+$/, ''), apiKey: config.apiKey || '', maxTokens, timeoutMs }
}

/** Own wire credentials explicitly, including keyless local inference servers. */
function configuredFetch(apiFormat: string, apiKey: string): typeof fetch {
  return (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    for (const name of ['authorization', 'x-api-key', 'api-key', 'cookie', 'openai-organization', 'openai-project']) {
      headers.delete(name)
    }
    if (apiKey) {
      headers.set(apiFormat === 'anthropic-messages' ? 'x-api-key' : 'authorization',
        apiFormat === 'anthropic-messages' ? apiKey : `Bearer ${apiKey}`)
    }
    // Keep configured credentials on this endpoint instead of forwarding redirects.
    return globalThis.fetch(input, { ...init, headers, credentials: 'omit', redirect: 'error' })
  }
}

function upstreamError(message: unknown): AgentError {
  // SDK error messages can contain upstream bodies, request headers or credentials.
  // Only classify them; never expose their text, causes or stack to callers.
  const detail = String(message || '')
  if (/\b(?:401|403)\b|unauthorized|authentication|invalid.?api.?key/i.test(detail)) {
    return agentError('PI_UPSTREAM_AUTH', '模型服务鉴权失败，请检查 API Key。')
  }
  if (/\b404\b|model.{0,30}(?:not found|does not exist)/i.test(detail)) {
    return agentError('PI_UPSTREAM_MODEL', '模型或接口不存在，请检查接口地址和模型名称。')
  }
  if (/\b429\b|rate.?limit/i.test(detail)) {
    return agentError('PI_UPSTREAM_LIMIT', '模型服务请求受限，请稍后重试。')
  }
  return agentError('PI_UPSTREAM_ERROR', '模型服务请求失败，请检查接口配置及服务状态。')
}

/** Model, provider and wire credentials shared by the single-turn and tool loops. */
function createRuntime(config: AiConfig): PiRuntime {
  const { factory, baseUrl, apiKey, maxTokens, timeoutMs } = validateConfig(config)
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
    identity: { attribution: null },
  }) as any
  const model = {
    id: config.model,
    name: config.model,
    provider: PROVIDER_ID,
    api: config.apiFormat,
    baseUrl,
    reasoning: false,
    input: ['text'],
    contextWindow: 131072,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(config.apiFormat === 'openai-completions' ? {
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, maxTokensField: 'max_tokens' },
    } : {}),
  }
  // Pi's SDK-backed APIs currently require a nonempty client credential. For a
  // keyless server this placeholder is removed by configuredFetch before HTTP.
  const sdkKey = apiKey || 'anishare-keyless-local'
  models.setProvider(createProvider({
    id: PROVIDER_ID,
    name: 'AniShare configured model',
    baseUrl,
    // SDK 的模型联合类型按 api 字面量收窄，这里的 api 是运行时配置，只能放宽到 any。
    models: [model as any],
    auth: { apiKey: { name: 'Configured key', resolve: async () => ({ auth: { apiKey: sdkKey } }) } },
    api: factory() as any,
  }))
  return { models, model, sdkKey, fetch: configuredFetch(config.apiFormat, apiKey), maxTokens, timeoutMs, apiFormat: config.apiFormat }
}

function streamOptions(runtime: PiRuntime, controller: AbortController, options: any = {}): Record<string, unknown> {
  return {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
    apiKey: runtime.sdkKey,
    fetch: runtime.fetch,
    maxTokens: runtime.maxTokens,
    timeoutMs: runtime.timeoutMs,
    maxRetries: 0,
    cacheRetention: 'none',
    transport: 'sse',
  }
}

/**
 * Run one isolated, tool-free Pi Agent turn with a literal configured model.
 * No CLI, file credentials, built-in providers or ambient API keys are loaded.
 */
export async function runPiAgent(config: AiConfig, { prompt, signal }: { prompt: string; signal?: AbortSignal } = { prompt: '' }): Promise<{ text: string; usage?: unknown; model: string; stopReason?: string }> {
  const runtime = createRuntime(config)
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 500000) {
    throw agentError('PI_PROMPT_INVALID', '模型请求内容为空或过长。', 400)
  }
  if (signal?.aborted) throw agentError('PI_ABORTED', '模型请求已取消。', 499)
  const { maxTokens, timeoutMs } = runtime

  const controller = new AbortController()
  const agent: any = new Agent({
    initialState: {
      model: runtime.model,
      systemPrompt: '帮助用户整理个人媒体库。遵循用户要求的输出格式，将提供的文件名和元数据作为资料处理。',
      thinkingLevel: 'off',
      tools: [],
    },
    identity: { attribution: null },
    streamFn: (selectedModel: unknown, context: unknown, options: any = {}) => runtime.models.streamSimple(selectedModel, context, streamOptions(runtime, controller, options)),
    // A configured model gets one response; unexpected tool calls cannot cause
    // extra model requests or execute any server capabilities.
    beforeToolCall: async () => ({ block: true, reason: '此任务未开放工具。', terminate: true }),
    finishTurn: async () => ({ action: 'end' }),
  })

  let cancellation: AgentError | undefined
  let rejectCancellation!: (error: AgentError) => void
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
  const cancel = (error: AgentError) => {
    if (cancellation) return
    cancellation = error
    controller.abort()
    agent.abort()
    rejectCancellation(error)
  }
  const onAbort = () => cancel(agentError('PI_ABORTED', '模型请求已取消。', 499))
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = setTimeout(() => cancel(agentError('PI_TIMEOUT', '模型请求超时，请稍后重试。', 504)), timeoutMs)
  let textLength = 0
  const maxCharacters = Math.min(1000000, maxTokens * 32 + 4096)
  const unsubscribe = agent.subscribe((event: any) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      textLength += event.assistantMessageEvent.delta.length
      if (textLength > maxCharacters) cancel(agentError('PI_OUTPUT_LIMIT', '模型返回内容过长，请减少输出上限或缩小整理范围。'))
    }
  })
  try {
    await Promise.race([agent.prompt(prompt), cancelled])
    if (cancellation) throw cancellation
    const assistant = agent.state.messages.findLast((message: any) => message.role === 'assistant')
    if (!assistant || assistant.stopReason === 'error') throw upstreamError(assistant?.errorMessage || agent.state.errorMessage)
    if (assistant.stopReason === 'aborted') throw agentError('PI_ABORTED', '模型请求已取消。', 499)
    if (assistant.stopReason === 'toolUse' || assistant.content.some((block: any) => block.type === 'toolCall')) {
      throw agentError('PI_UNEXPECTED_TOOLS', '模型请求使用了未开放的工具，请调整提示后重试。')
    }
    const text = assistant.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('').trim()
    if (!text) throw agentError('PI_EMPTY_RESPONSE', '模型没有返回可用内容，请重试或更换模型。')
    if (text.length > maxCharacters) throw agentError('PI_OUTPUT_LIMIT', '模型返回内容过长，请减少输出上限或缩小整理范围。')
    return { text, usage: assistant.usage, model: config.model, stopReason: assistant.stopReason }
  } catch (error) {
    if (cancellation) throw cancellation
    if (typeof (error as AgentError)?.code === 'string' && (error as AgentError).code.startsWith('PI_')) throw error
    throw upstreamError((error as Error)?.message)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    unsubscribe()
    controller.abort()
    agent.abort()
  }
}

/**
 * Tool-enabled loop for background work (media scan) and conversational agents.
 * Every tool is bounded by `maxToolCalls`; the conversation is bounded by `maxTurns` and an
 * overall budget. Tools that throw become error results for the model instead of failing the run.
 * `history` is replayed as real prior turns, and `onEvent` streams text/tool activity to the caller.
 */
export async function runPiAgentWithTools(config: AiConfig, {
  prompt, systemPrompt, tools = [], history, signal, maxTurns = 10, maxToolCalls = 32,
  timeoutMs: budgetMs = 120000, onEvent,
}: AgentRunOptions): Promise<AgentRunResult> {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) throw agentError('PI_PROMPT_INVALID', '模型请求内容为空或过长。', 400)
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim() || systemPrompt.length > 100000) throw agentError('PI_PROMPT_INVALID', '系统提示词为空或过长。', 400)
  if (!Array.isArray(tools) || tools.length > 32) throw agentError('PI_TOOLS_INVALID', '工具定义无效。', 400)
  const runtime = createRuntime(config)
  const seeded = seededHistory(config, history)
  if (signal?.aborted) throw agentError('PI_ABORTED', '模型请求已取消。', 499)

  let turns = 0
  let calls = 0
  const emit = (event: AgentStreamEvent): void => {
    // 展示回调属于调用方，抛错不能打断 Agent。
    try { onEvent?.(event) } catch { /* ignored by design */ }
  }
  const guarded = tools.map((tool) => ({
    ...tool,
    executionMode: tool.executionMode ?? 'sequential',
    async execute(...args: any[]) {
      calls += 1
      if (calls > maxToolCalls) throw agentError('PI_TOOL_LIMIT', '工具调用次数超过上限。', 429)
      return tool.execute(...(args as [string, Record<string, any>, AbortSignal?]))
    },
  }))

  const controller = new AbortController()
  const budget = budgetMs ?? 120000
  const agent: any = new Agent({
    initialState: {
      model: runtime.model, systemPrompt, thinkingLevel: 'off', tools: guarded as any,
      ...(seeded.length ? { messages: seeded } : {}),
    },
    identity: { attribution: null },
    streamFn: (selectedModel: unknown, context: unknown, options: any = {}) => runtime.models.streamSimple(selectedModel, context, streamOptions(runtime, controller, options)),
    finishTurn: async () => {
      turns += 1
      return turns >= maxTurns ? { action: 'end' } : undefined
    },
  })
  const unsubscribe = agent.subscribe((event: any) => {
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent
      if (update?.type === 'text_delta' && typeof update.delta === 'string' && update.delta) emit({ type: 'delta', text: update.delta })
    } else if (event.type === 'tool_execution_start') {
      emit({ type: 'tool_start', toolCallId: String(event.toolCallId ?? ''), name: String(event.toolName ?? ''), args: event.args })
    } else if (event.type === 'tool_execution_end') {
      emit({
        type: 'tool_end', toolCallId: String(event.toolCallId ?? ''), name: String(event.toolName ?? ''),
        isError: Boolean(event.isError), ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
      })
    }
  })

  let timedOut = false
  const onAbort = () => { controller.abort(); agent.abort() }
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { timedOut = true; onAbort() }, budget)
  try {
    await agent.prompt(prompt)
  } catch (error) {
    if (signal?.aborted) throw agentError('PI_ABORTED', '模型请求已取消。', 499)
    if (timedOut) throw agentError('PI_TIMEOUT', '模型请求超时，请稍后重试。', 504)
    if (typeof (error as AgentError)?.code === 'string' && (error as AgentError).code.startsWith('PI_')) throw error
    throw upstreamError((error as Error)?.message)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    unsubscribe()
    controller.abort()
    agent.abort()
  }
  if (signal?.aborted) throw agentError('PI_ABORTED', '模型请求已取消。', 499)
  if (timedOut) throw agentError('PI_TIMEOUT', '模型请求超时，请稍后重试。', 504)

  const assistant = agent.state.messages.findLast((message: any) => message.role === 'assistant')
  if (assistant?.stopReason === 'error') throw upstreamError(assistant.errorMessage || agent.state.errorMessage)
  const text = (assistant?.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('').trim()
  return {
    text, usage: assistant?.usage, model: config.model, stopReason: assistant?.stopReason,
    turns, toolCalls: calls,
  }
}
