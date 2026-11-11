import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AgentService } from '../service/agent.service.ts'
import type { AiSettingsService } from '../service/ai-settings.service.ts'
import type { AuthService } from '../service/auth.service.ts'
import type { DeepSeekSearchService } from '../service/deepseek-search.service.ts'
import type { SearchSettingsService } from '../service/search-settings.service.ts'

const localErrors: ReadonlySet<string> = new Set([
  'AI_CONFIG_INVALID', 'AI_NOT_CONFIGURED', 'AI_DISABLED', 'AI_CONFIG_KEY_UNAVAILABLE',
  'AI_CONFIG_DECRYPTION_FAILED', 'AI_CONFIG_UNAVAILABLE', 'AI_PROMPT_INVALID',
  'SEARCH_CONFIG_INVALID', 'SEARCH_NOT_CONFIGURED', 'SEARCH_DISABLED', 'SEARCH_CONFIG_KEY_UNAVAILABLE',
  'SEARCH_CONFIG_DECRYPTION_FAILED', 'SEARCH_CONFIG_UNAVAILABLE', 'SEARCH_QUERY_INVALID', 'SEARCH_URL_INVALID',
  'SEARCH_TIMEOUT', 'SEARCH_ABORTED', 'SEARCH_AUTH_FAILED', 'SEARCH_RATE_LIMITED',
  'SEARCH_UPSTREAM_UNAVAILABLE', 'SEARCH_UPSTREAM_REJECTED', 'SEARCH_UPSTREAM_INVALID',
])

/** Service errors are plain Error objects carrying HTTP fields; read them structurally. */
interface HttpFailure {
  status?: number
  statusCode?: number
  code?: string
  name?: string
  message?: string
}

const failureOf = (error: unknown): HttpFailure => error as HttpFailure

/** Request bodies are dynamic JSON; the agent service validates every field it reads. */
const jsonBody = (request: FastifyRequest): Record<string, unknown> => request.body as Record<string, unknown>

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface AiControllerDependencies {
  readonly aiSettingsService: AiSettingsService
  readonly agentService: AgentService
  readonly authService: AuthService
  readonly searchSettingsService: SearchSettingsService
  readonly searchService: DeepSeekSearchService
}

export function registerAiController(app: FastifyInstance, { aiSettingsService, agentService, authService, searchSettingsService, searchService }: AiControllerDependencies): void {
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    reply.header('Cache-Control', 'no-store')
    if (!authService.enabled) return reply.code(403).send({ error: '请先配置 AUTH_SECRET，登录后才能使用 AI 后台和 Agent', code: 'ADMIN_AUTH_REQUIRED' })
    return undefined
  }
  const sendError = (reply: FastifyReply, error: unknown): FastifyReply => {
    const failure = failureOf(error)
    const status = failure.status || failure.statusCode || 500
    const code = typeof failure.code === 'string' ? failure.code : ''
    if (code && localErrors.has(code) && status >= 400 && status < 600) return reply.code(status).send({ error: failure.message, code })
    if (status === 408 || status === 504 || failure.name === 'AbortError' || code === 'AI_TIMEOUT') {
      return reply.code(504).send({ error: 'AI 服务响应超时，请稍后重试或调整超时时间', code: 'AI_REQUEST_TIMEOUT' })
    }
    return reply.code(status === 400 ? 400 : 502).send({ error: 'AI 服务调用失败，请检查模型配置或稍后重试', code: 'AI_REQUEST_FAILED' })
  }
  const execute = async <T>(req: FastifyRequest, reply: FastifyReply, operation: (signal: AbortSignal) => T | Promise<T>): Promise<T> => {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    const responseClosed = (): void => { if (!reply.raw.writableEnded) abort() }
    req.raw.once('aborted', abort)
    reply.raw.once('close', responseClosed)
    if (req.raw.aborted || reply.raw.destroyed) abort()
    try { return await operation(controller.signal) }
    finally {
      req.raw.off('aborted', abort)
      reply.raw.off('close', responseClosed)
    }
  }
  app.get('/api/admin/ai/config', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try { return { config: aiSettingsService.publicConfig() } } catch (error) { return sendError(reply, error) }
  })
  app.put('/api/admin/ai/config', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try { return { config: aiSettingsService.save(req.body) } } catch (error) { return sendError(reply, error) }
  })
  app.post('/api/admin/ai/test', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      return await execute(req, reply, (signal: AbortSignal) => agentService.test(jsonBody(req), { signal }))
    } catch (error) { return sendError(reply, error) }
  })
  // 联网搜索配置：与模型配置分离的本机密钥存储（app_settings 的另一个 type）。
  app.get('/api/admin/ai/search', { preHandler: requireAdmin }, async (_req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try { return { config: searchSettingsService.publicConfig() } } catch (error) { return sendError(reply, error) }
  })
  app.put('/api/admin/ai/search', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try { return { config: searchSettingsService.save(req.body) } } catch (error) { return sendError(reply, error) }
  })
  app.post('/api/admin/ai/search/test', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      return await execute(req, reply, (signal: AbortSignal) => searchService.test(jsonBody(req), { signal }))
    } catch (error) { return sendError(reply, error) }
  })
  app.post('/api/agent/run', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      return await execute(req, reply, (signal: AbortSignal) => agentService.run(jsonBody(req), { signal }))
    } catch (error) { return sendError(reply, error) }
  })
}
