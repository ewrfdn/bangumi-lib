import type { AgentManager } from '../agent/AgentManager.ts'
import type { AgentRunResult, AgentStreamEvent, AgentTool } from '../agent/types.ts'
import type { AiSettingsService } from './ai-settings.service.ts'

/** 一轮已完成的对话；与 docs/chat-agent-api.md 的 history 契约一致。 */
export interface ChatConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Chat Agent 的上下文：历史轮次按时间正序，最后一条是最新用户消息。 */
export interface ChatContext {
  messages: ChatConversationMessage[]
}

/** 展示给 WebSocket 客户端的工具摘要；绝不包含服务端配置（如 apiKey）。 */
export interface ChatToolInfo {
  name: string
  label: string
  description: string
}

export interface ChatReadyState {
  aiEnabled: boolean
  model: string | null
  tools: ChatToolInfo[]
}

export interface ChatRunOptions {
  signal?: AbortSignal
  onEvent?: (event: AgentStreamEvent) => void
}

export interface ChatService {
  /** 握手时下发给前端的静态能力信息；不负责判断模型是否可用。 */
  ready(): ChatReadyState
  /** 校验并归一一次对话请求，再交给 AgentManager 运行。 */
  chat(context: ChatContext, options?: ChatRunOptions): Promise<AgentRunResult>
}

/** 只依赖服务用到的能力，便于组合根与测试注入最小实现。 */
export interface ChatServiceDependencies {
  readonly agents: AgentManager
  readonly aiSettings: Pick<AiSettingsService, 'publicConfig'>
}

/** 与 pi.runtime 的历史上限保持一致，避免两处校验互相打架。 */
export const CHAT_MESSAGES_MAX = 41
export const CHAT_HISTORY_MAX_TURNS = 40
export const CHAT_MESSAGE_MAX_CHARS = 8_000
export const CHAT_HISTORY_MAX_CHARS = 48_000

type ChatFailureCode = 'CHAT_INVALID' | 'CHAT_HISTORY_INVALID'

/** 校验失败由 WebSocket 层转成 error 帧；沿用项目里 Error + status/code 的约定。 */
const failure = (code: ChatFailureCode, message: string): Error & { status: number; code: ChatFailureCode } =>
  Object.assign(new Error(message), { status: 400, code })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * 宽松归一历史：丢弃连续同角色消息（保留更靠近当前的一条）、去掉开头的 assistant、
 * 去掉末尾没有得到回复的 user 轮。最新一条用户消息不在归一范围内。
 */
function normalizeHistory(turns: ChatConversationMessage[]): ChatConversationMessage[] {
  const collapsed: ChatConversationMessage[] = []
  for (const turn of turns) {
    const previous = collapsed[collapsed.length - 1]
    if (previous && previous.role === turn.role) collapsed[collapsed.length - 1] = turn
    else collapsed.push(turn)
  }
  while (collapsed.length && collapsed[0].role === 'assistant') collapsed.shift()
  while (collapsed.length && collapsed[collapsed.length - 1].role === 'user') collapsed.pop()
  return collapsed
}

/**
 * 校验 messages 并用宽松规则归一历史，返回可直接交给 Chat Agent 的上下文。
 * 结构性问题一律以 400/ChatFailureCode 抛出，消息文案是可直接展示的中文。
 */
function normalizeMessages(value: unknown): ChatContext {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHAT_MESSAGES_MAX) {
    throw failure('CHAT_INVALID', '消息格式无效，请刷新页面后重试。')
  }
  const latestIndex = value.length - 1
  const parsed: ChatConversationMessage[] = []
  let historyChars = 0
  value.forEach((item, index) => {
    if (!isRecord(item)) throw failure('CHAT_INVALID', '消息格式无效，请刷新页面后重试。')
    const { role, content } = item
    const latest = index === latestIndex
    if (role !== 'user' && role !== 'assistant') {
      throw failure(latest ? 'CHAT_INVALID' : 'CHAT_HISTORY_INVALID', latest ? '最后一条消息必须来自用户。' : '对话历史格式无效，请先清空对话。')
    }
    if (typeof content !== 'string') {
      throw failure(latest ? 'CHAT_INVALID' : 'CHAT_HISTORY_INVALID', latest ? '消息内容不能为空。' : '对话历史格式无效，请先清空对话。')
    }
    const text = content.trim()
    if (!text) {
      throw failure(latest ? 'CHAT_INVALID' : 'CHAT_HISTORY_INVALID', latest ? '消息内容不能为空。' : '对话历史格式无效，请先清空对话。')
    }
    if (text.length > CHAT_MESSAGE_MAX_CHARS) {
      throw failure(latest ? 'CHAT_INVALID' : 'CHAT_HISTORY_INVALID', latest ? '消息内容过长，请精简到 8000 字以内。' : '对话历史过长，请先清空对话。')
    }
    if (!latest) {
      historyChars += text.length
      if (historyChars > CHAT_HISTORY_MAX_CHARS) throw failure('CHAT_HISTORY_INVALID', '对话历史过长，请先清空对话。')
    }
    parsed.push({ role, content: text })
  })
  const latest = parsed[latestIndex]
  if (latest.role !== 'user') throw failure('CHAT_INVALID', '最后一条消息必须来自用户。')
  const history = normalizeHistory(parsed.slice(0, latestIndex))
  return { messages: [...history, latest] }
}

export function createChatService({ agents, aiSettings }: ChatServiceDependencies): ChatService {
  return {
    ready(): ChatReadyState {
      const config = aiSettings.publicConfig()
      const agent = agents.get<ChatContext>('chat')
      const tools = agent.tools({ messages: [] }).map((tool: AgentTool): ChatToolInfo => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
      }))
      const model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : null
      return { aiEnabled: Boolean(config.enabled), model, tools }
    },
    async chat(context: ChatContext, { signal, onEvent }: ChatRunOptions = {}): Promise<AgentRunResult> {
      const { messages } = normalizeMessages(context?.messages)
      return agents.run('chat', { messages }, { signal, onEvent })
    },
  }
}
