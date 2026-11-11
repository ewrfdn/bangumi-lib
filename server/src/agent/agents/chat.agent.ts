import { BaseAgent } from '../base.agent.ts'
import { createChatTools } from '../tools/chat.tools.ts'
import { createSearchTools } from '../tools/search.tools.ts'
import type { AgentConversationTurn, AgentTool } from '../types.ts'
import type { CatalogModels } from '../../model/catalog.model.ts'
import type { AppConfig, Logger } from '../../types.ts'
import type { DeepSeekSearchService } from '../../service/deepseek-search.service.ts'
import type { SearchSettingsService } from '../../service/search-settings.service.ts'

/** 一条对话轮次；最新一条必须来自用户，作为本轮 prompt。 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatAgentContext {
  messages: ChatMessage[]
}

export interface ChatAgentDependencies {
  services: Record<string, any>
  models: CatalogModels
  settings: AppConfig
  logger?: Logger
  /** 联网搜索开启后向 Agent 注册 web_search / web_fetch 工具。 */
  search?: DeepSeekSearchService
  searchSettings?: SearchSettingsService
}

/**
 * 媒体助手：右下角悬浮窗里的多轮对话 Agent。
 * 服务端不保存对话，历史轮次由调用方随请求传入并回放给模型；工具负责真实的查询与归档。
 */
export class ChatAgent extends BaseAgent<ChatAgentContext> {
  readonly type = 'chat'
  readonly label = '媒体助手'
  readonly maxTurns = 10
  readonly maxToolCalls = 32
  readonly timeoutMs = 120_000

  readonly #services: Record<string, any>
  readonly #models: CatalogModels
  readonly #settings: AppConfig
  readonly #logger?: Logger
  readonly #search?: DeepSeekSearchService
  readonly #searchSettings?: SearchSettingsService

  constructor({ services, models, settings, logger, search, searchSettings }: ChatAgentDependencies) {
    super()
    this.#services = services
    this.#models = models
    this.#settings = settings
    this.#logger = logger
    this.#search = search
    this.#searchSettings = searchSettings
  }

  systemPrompt(): string {
    return this.promptFile('chat.md')
  }

  /** 最新一条用户消息是本轮问题；历史轮次由 history() 回放。 */
  userPrompt({ messages }: ChatAgentContext): string {
    const turns = Array.isArray(messages) ? messages : []
    const latest = turns[turns.length - 1]
    const content = typeof latest?.content === 'string' ? latest.content.trim() : ''
    if (!latest || latest.role !== 'user' || !content) throw new Error('对话缺少最新的用户提问')
    return latest.content
  }

  history({ messages }: ChatAgentContext): AgentConversationTurn[] {
    const turns = Array.isArray(messages) ? messages : []
    return turns.slice(0, -1).map((turn): AgentConversationTurn => ({ role: turn.role, content: turn.content }))
  }

  tools(_context: ChatAgentContext): AgentTool[] {
    const tools = createChatTools({
      services: this.#services, models: this.#models, settings: this.#settings, logger: this.#logger,
    })
    // 联网搜索是可选能力：启用且配置了可用密钥时才注册工具；
    // 未配置密钥时模型完全看不到 web_search / web_fetch。
    if (this.#search && this.#searchSettings?.usable()) {
      tools.push(...createSearchTools({ search: this.#search, logger: this.#logger }))
    }
    return tools
  }
}
