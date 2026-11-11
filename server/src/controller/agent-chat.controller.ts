import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { RawData } from 'ws'
import { sessionToken } from './auth.controller.ts'
import type { AgentStreamEvent } from '../agent/types.ts'
import type { ChatReadyState, ChatService } from '../service/chat.service.ts'
import type { AuthService } from '../service/auth.service.ts'
import type { AppConfig, Logger } from '../types.ts'

/** 前端使用的同源地址；其他 Upgrade 请求一律拒绝。 */
export const AGENT_CHAT_PATH = '/api/agent/chat'

const MAX_PAYLOAD_BYTES = 256 * 1024
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MESSAGE_MAX_CHARS = 8_000
const HISTORY_MAX_TURNS = 40
const HISTORY_MAX_CHARS = 48_000
/** 只放行本项目自定义的安全错误码，避免把底层错误码/正文透给前端。 */
const SAFE_ERROR_CODE = /^(?:AI|PI|CHAT)_[A-Z][A-Z0-9_]{0,63}$/

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' }

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

interface RunningChat {
  id: string
  controller: AbortController
  aborted: boolean
}

export interface AgentChatControllerDependencies {
  readonly chatService: ChatService
  readonly authService: AuthService
  readonly settings: Pick<AppConfig, 'frontendOrigins'>
  readonly logger?: Logger
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const rawText = (data: RawData): string => {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/** 升级请求被拒时回一个最小的 HTTP 响应并关闭 socket；客户端会收到非 101 状态。 */
function refuseUpgrade(socket: Duplex, status: number, message: string, code?: string): void {
  const body = JSON.stringify({ error: message, ...(code ? { code } : {}) })
  const response = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'Error'}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    '',
    body,
  ].join('\r\n')
  try {
    if (!socket.destroyed) socket.write(response)
  } catch { /* 对端可能已断开，握手失败无需上报。 */ }
  try { socket.end() } catch { /* ignored */ }
}

/**
 * WS 客户端发来的 history 只做协议层校验：最多 40 条、每条 1–8000 字符、合计 ≤48000；
 * 角色交替等宽松归一是 chat.service 的职责。
 */
function parseHistory(value: unknown): ChatTurn[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > HISTORY_MAX_TURNS) return null
  const turns: ChatTurn[] = []
  let total = 0
  for (const item of value) {
    if (!isRecord(item)) return null
    const { role, content } = item
    if (role !== 'user' && role !== 'assistant') return null
    if (typeof content !== 'string') return null
    const text = content.trim()
    if (!text || text.length > MESSAGE_MAX_CHARS) return null
    total += text.length
    if (total > HISTORY_MAX_CHARS) return null
    turns.push({ role, content: text })
  }
  return turns
}

/**
 * 把 Agent 运行异常转成安全的中文错误帧。
 * AI_ / PI_ / CHAT_ 前缀的消息由服务层自己生成（pi.runtime 不携带上游正文与密钥）；
 * 其余一律 CHAT_FAILED，避免泄露内部实现。
 */
function describeChatError(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown }
  const code = typeof candidate?.code === 'string' && SAFE_ERROR_CODE.test(candidate.code) ? candidate.code : ''
  if (!code) return { code: 'CHAT_FAILED', message: '助手暂时无法回复，请稍后重试。' }
  if (code === 'PI_TIMEOUT') return { code, message: '模型响应超时，请稍后重试。' }
  const message = typeof candidate.message === 'string' ? candidate.message.trim() : ''
  return message ? { code, message: message.slice(0, 300) } : { code, message: '助手暂时无法回复，请稍后重试。' }
}

/**
 * 「媒体助手」WebSocket 网关：握手鉴权 + 单连接串行对话 + 流式帧转发。
 * 对话不落库、不写日志正文；连接关闭或 app.close 时取消进行中的 Agent。
 */
export function registerAgentChatController(app: FastifyInstance, deps: AgentChatControllerDependencies): void {
  const { chatService, authService, settings, logger } = deps
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, clientTracking: true })
  /** ws -> 取消进行中一轮的回调，供 app.close 时统一清理。 */
  const connections = new Map<WebSocket, () => void>()
  let closing = false

  const originAllowed = (request: IncomingMessage): boolean => {
    const origin = request.headers.origin
    if (!origin) return true
    let parsed: URL
    try { parsed = new URL(origin) } catch { return false }
    if (parsed.host === request.headers.host) return true
    return Boolean(settings.frontendOrigins?.includes(parsed.origin))
  }

  const handleConnection = (ws: WebSocket): void => {
    let closed = false
    let running: RunningChat | null = null
    let toolLabels = new Map<string, string>()

    const send = (frame: Record<string, unknown>): void => {
      if (closed || ws.readyState !== WebSocket.OPEN) return
      try { ws.send(JSON.stringify(frame)) } catch { /* 发送失败不能打断 Agent 运行。 */ }
    }

    const abortRunning = (): void => {
      const state = running
      if (!state || state.aborted) return
      // 先标记再中止：abort 之后的流式事件与后续 chat 帧都要被丢弃/拒绝，直到本轮真正结束。
      state.aborted = true
      state.controller.abort()
    }

    connections.set(ws, abortRunning)
    ws.on('error', () => { /* 连接级错误由 close 事件统一清理。 */ })
    ws.on('close', () => {
      closed = true
      abortRunning()
      connections.delete(ws)
    })

    let ready: ChatReadyState
    try {
      ready = chatService.ready()
    } catch {
      logger?.warn?.({ code: 'CHAT_NOT_READY' }, '媒体助手初始化失败')
      send({ type: 'error', code: 'CHAT_NOT_READY', message: '助手尚未就绪，请稍后重试。' })
      try { ws.close(1011, 'not ready') } catch { /* ignored */ }
      return
    }
    toolLabels = new Map(ready.tools.map((tool) => [tool.name, tool.label]))
    send({
      type: 'ready',
      agent: { type: 'chat', label: '媒体助手' },
      aiEnabled: ready.aiEnabled,
      model: ready.model,
      tools: ready.tools,
    })

    const onEvent = (event: AgentStreamEvent): void => {
      const state = running
      if (!state || state.aborted) return
      if (event.type === 'delta') {
        if (event.text) send({ type: 'delta', id: state.id, text: event.text })
        return
      }
      const label = toolLabels.get(event.name) || event.name
      if (event.type === 'tool_start') {
        send({ type: 'tool', id: state.id, toolCallId: event.toolCallId, name: event.name, label, phase: 'start' })
        return
      }
      send({
        type: 'tool', id: state.id, toolCallId: event.toolCallId, name: event.name, label,
        phase: 'end', ok: !event.isError, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      })
    }

    const startChat = async (frame: Record<string, unknown>): Promise<void> => {
      const id = typeof frame.id === 'string' && ID_PATTERN.test(frame.id) ? frame.id : ''
      if (!id) {
        send({ type: 'error', code: 'CHAT_INVALID', message: '消息编号无效，请刷新页面后重试。' })
        return
      }
      if (running) {
        send({ type: 'error', id, code: 'CHAT_BUSY', message: '上一轮对话仍在进行中，请稍候。' })
        return
      }
      if (typeof frame.message !== 'string' || !frame.message.trim()) {
        send({ type: 'error', id, code: 'CHAT_INVALID', message: '消息内容不能为空。' })
        return
      }
      const message = frame.message.trim()
      if (message.length > MESSAGE_MAX_CHARS) {
        send({ type: 'error', id, code: 'CHAT_INVALID', message: '消息内容过长，请精简到 8000 字以内。' })
        return
      }
      const history = parseHistory(frame.history)
      if (!history) {
        send({ type: 'error', id, code: 'CHAT_HISTORY_INVALID', message: '对话历史格式无效，请先清空对话。' })
        return
      }
      const state: RunningChat = { id, controller: new AbortController(), aborted: false }
      running = state
      send({ type: 'start', id })
      try {
        const result = await chatService.chat(
          { messages: [...history, { role: 'user', content: message }] },
          { signal: state.controller.signal, onEvent },
        )
        if (state.controller.signal.aborted) {
          send({ type: 'aborted', id })
          return
        }
        send({ type: 'done', id, text: result.text, turns: result.turns ?? 0, toolCalls: result.toolCalls ?? 0 })
      } catch (error) {
        if (state.controller.signal.aborted) {
          send({ type: 'aborted', id })
          return
        }
        const failure = describeChatError(error)
        logger?.warn?.({ code: failure.code }, '媒体助手对话失败')
        send({ type: 'error', id, code: failure.code, message: failure.message })
      } finally {
        if (running === state) running = null
      }
    }

    const handleFrame = (raw: RawData): void => {
      let frame: unknown
      try { frame = JSON.parse(rawText(raw)) } catch {
        send({ type: 'error', code: 'CHAT_INVALID', message: '消息格式无效，请重试。' })
        return
      }
      if (!isRecord(frame)) {
        send({ type: 'error', code: 'CHAT_INVALID', message: '消息格式无效，请重试。' })
        return
      }
      switch (frame.type) {
        case 'ping': send({ type: 'pong' }); return
        case 'abort': abortRunning(); return
        case 'chat': void startChat(frame); return
        default: send({ type: 'error', code: 'CHAT_INVALID', message: '不支持的消息类型。' })
      }
    }

    ws.on('message', (data: RawData) => { handleFrame(data) })
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => { /* 握手阶段的 socket 错误无需上报。 */ })
    let pathname = ''
    try { pathname = new URL(request.url || '/', 'http://localhost').pathname } catch { /* 交给下面的 404 处理。 */ }
    if (pathname !== AGENT_CHAT_PATH) {
      refuseUpgrade(socket, 404, '接口不存在')
      return
    }
    if (closing) {
      refuseUpgrade(socket, 503, '服务正在关闭，请稍后重试。')
      return
    }
    if (!authService.enabled) {
      refuseUpgrade(socket, 403, '请先配置 AUTH_SECRET，登录后才能使用 AI 助手', 'ADMIN_AUTH_REQUIRED')
      return
    }
    if (!authService.session(sessionToken(request.headers.cookie)).authenticated) {
      refuseUpgrade(socket, 401, '请先输入访问密钥登录', 'UNAUTHORIZED')
      return
    }
    if (!originAllowed(request)) {
      refuseUpgrade(socket, 403, '不允许跨站请求')
      return
    }
    try {
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => { handleConnection(ws) })
    } catch {
      refuseUpgrade(socket, 400, '握手失败，请刷新页面后重试。')
    }
  }

  const removeUpgradeListener = (): void => {
    try { app.server.off('upgrade', onUpgrade) } catch { /* ignored */ }
  }
  /** 先中止在跑的 Agent 并断开所有连接，避免 http server 关闭时等待 Upgrade socket。 */
  const shutdown = (): void => {
    closing = true
    for (const abort of [...connections.values()]) {
      try { abort() } catch { /* ignored */ }
    }
    for (const ws of wss.clients) {
      try { ws.terminate() } catch { /* ignored */ }
    }
  }
  const closeServer = (): Promise<void> => new Promise<void>((resolve) => {
    let called = false
    const finish = (): void => { if (!called) { called = true; resolve() } }
    try { wss.close(() => finish()) } catch { finish() }
    setTimeout(finish, 1000).unref()
  })

  wss.on('error', () => { logger?.warn?.({ code: 'WS_SERVER_ERROR' }, '媒体助手 WebSocket 服务异常') })
  app.server.on('upgrade', onUpgrade)
  // preClose 在 Fastify 关闭 HTTP server 之前执行，是清理 Upgrade 连接的正确时机。
  app.addHook('preClose', async () => {
    removeUpgradeListener()
    shutdown()
  })
  app.addHook('onClose', async () => {
    removeUpgradeListener()
    shutdown()
    await closeServer()
  })
}
