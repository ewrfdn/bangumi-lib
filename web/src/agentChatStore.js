/**
 * 「媒体助手」对话的浏览器本地存储与协议辅助。
 *
 * 全部为纯函数/无副作用工具（localStorage 由调用方传入或从 globalThis 读取），
 * 便于用 node:test 直接覆盖，不依赖 Vue 或 DOM。
 * 契约见 docs/chat-agent-api.md：对话只存在于 localStorage，服务端无状态。
 */

/** 对话在 localStorage 中的键名。 */
export const CHAT_STORAGE_KEY = 'anishare.agent.chat.v1'
/** 本地存储结构版本。 */
export const CHAT_VERSION = 1
/** 本地最多保留的消息条数。 */
export const MAX_MESSAGES = 100
/** 本地正文合计最大字符数。 */
export const MAX_CHARS = 100000
/** 单次请求历史最多条数（服务端限制）。 */
export const MAX_HISTORY_MESSAGES = 40
/** 单次请求历史正文合计最大字符数（服务端限制）。 */
export const MAX_HISTORY_CHARS = 48000
/** 单条消息正文最大字符数（客户端输入与历史裁剪共用，服务端限制 8000）。 */
export const MAX_MESSAGE_CHARS = 8000

const ROLES = new Set(['user', 'assistant'])
const STATUSES = new Set(['ok', 'error', 'aborted'])
const SERVER_FRAME_TYPES = new Set(['ready', 'start', 'delta', 'tool', 'done', 'error', 'aborted', 'pong'])
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 空会话（每次返回新对象）。 */
export function emptyConversation() {
  return { version: CHAT_VERSION, updatedAt: 0, messages: [] }
}

/**
 * 解析一个可用的 Storage。调用方显式传入优先；否则回退 globalThis.localStorage。
 * 隐私模式/禁用存储时读取该属性本身就可能抛错，因此整个解析过程都包在 try 里。
 */
function resolveStorage(storage) {
  try {
    if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') return storage
  } catch {
    return null
  }
  try {
    const fallback = globalThis.localStorage
    if (fallback && typeof fallback.getItem === 'function' && typeof fallback.setItem === 'function') return fallback
  } catch {
    /* 存储被禁用：安全降级为不使用存储 */
  }
  return null
}

/** 校验并归一化单条消息；不合法返回 null。 */
function normalizeMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { role, content, at, status } = value
  if (!ROLES.has(role)) return null
  if (typeof content !== 'string') return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (!STATUSES.has(status)) return null
  return { role, content, at, status }
}

/**
 * 从 localStorage 读取对话。
 * 坏 JSON / 结构不符 / 版本不符 / 任何一条消息不合法 → 空会话；storage 不可用也返回空会话，绝不抛错。
 */
export function loadConversation(storage) {
  const target = resolveStorage(storage)
  if (!target) return emptyConversation()
  let raw
  try {
    raw = target.getItem(CHAT_STORAGE_KEY)
  } catch {
    return emptyConversation()
  }
  if (typeof raw !== 'string' || !raw) return emptyConversation()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyConversation()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyConversation()
  if (parsed.version !== CHAT_VERSION || !Array.isArray(parsed.messages)) return emptyConversation()
  const messages = []
  for (const entry of parsed.messages) {
    const message = normalizeMessage(entry)
    if (!message) return emptyConversation()
    messages.push(message)
  }
  const updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0
  return { version: CHAT_VERSION, updatedAt, messages: trimConversation(messages) }
}

/**
 * 保存对话（写入前按本地上限裁剪）。返回是否写入成功，不抛错。
 * 传入的 messages 里不合法的条目会被忽略；不是数组时返回 false。
 */
export function saveConversation(state, storage) {
  const target = resolveStorage(storage)
  if (!target) return false
  const source = state && typeof state === 'object' ? state.messages : null
  if (!Array.isArray(source)) return false
  const messages = []
  for (const entry of source) {
    const message = normalizeMessage(entry)
    if (message) messages.push(message)
  }
  const payload = { version: CHAT_VERSION, updatedAt: Date.now(), messages: trimConversation(messages) }
  try {
    target.setItem(CHAT_STORAGE_KEY, JSON.stringify(payload))
    return true
  } catch {
    // 配额满 / 存储被禁用：安全降级，本次会话继续在内存里工作。
    return false
  }
}

/** 删除本地对话（即"清空"）。返回是否删除成功，不抛错。 */
export function clearConversation(storage) {
  const target = resolveStorage(storage)
  if (!target) return false
  try {
    target.removeItem(CHAT_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

/** 追加一条消息，返回新数组（不修改入参）。turn 不合法时返回浅拷贝。 */
export function appendTurn(messages, turn) {
  const list = Array.isArray(messages) ? messages.slice() : []
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return list
  if (!ROLES.has(turn.role) || typeof turn.content !== 'string') return list
  const status = STATUSES.has(turn.status) ? turn.status : 'ok'
  const at = typeof turn.at === 'number' && Number.isFinite(turn.at) ? turn.at : Date.now()
  list.push({ role: turn.role, content: turn.content, at, status })
  return list
}

/**
 * 按上限裁剪对话：超出时从最旧的整轮（一条 user 到下一个 user 之前）开始丢弃，
 * 保持剩余消息的原顺序。只做浅拷贝，消息上的额外展示字段会保留。
 */
export function trimConversation(messages, options) {
  if (!Array.isArray(messages)) return []
  const { maxMessages = MAX_MESSAGES, maxChars = MAX_CHARS } = options && typeof options === 'object' ? options : {}
  const maxCount = Number.isFinite(maxMessages) && maxMessages >= 0 ? Math.floor(maxMessages) : MAX_MESSAGES
  const maxLength = Number.isFinite(maxChars) && maxChars >= 0 ? Math.floor(maxChars) : MAX_CHARS
  let list = messages
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({ ...entry, content: typeof entry.content === 'string' ? entry.content : '' }))
  const totalChars = () => list.reduce((sum, entry) => sum + entry.content.length, 0)
  while (list.length > maxCount || totalChars() > maxLength) {
    if (!list.length) break
    // 丢掉最旧一整轮：直到下一个 user 消息（含当前 user 及其回复）。
    let nextUser = list.length
    for (let index = 1; index < list.length; index += 1) {
      if (list[index].role === 'user') {
        nextUser = index
        break
      }
    }
    list = list.slice(nextUser)
  }
  return list
}

/** 从消息列表构造下一次请求的 history（近 40 条 / 48000 字符，正序，以 assistant 结尾或为空）。 */
function historyFromMessages(messages) {
  const source = Array.isArray(messages) ? messages : []
  const history = []
  let chars = 0
  for (let index = source.length - 1; index >= 0 && history.length < MAX_HISTORY_MESSAGES; index -= 1) {
    const entry = source[index]
    if (!entry || typeof entry !== 'object') continue
    if (entry.role !== 'user' && entry.role !== 'assistant') continue
    // 失败/中止的轮次不重放；正文为空的也不发送。
    if (entry.status !== 'ok' || typeof entry.content !== 'string') continue
    const content = entry.content.slice(0, MAX_MESSAGE_CHARS)
    if (!content.trim()) continue
    if (chars + content.length > MAX_HISTORY_CHARS) break
    history.unshift({ role: entry.role, content })
    chars += content.length
  }
  // 历史必须以 assistant 结尾（或为空），去掉末尾未得到回复的 user 轮。
  while (history.length && history[history.length - 1].role !== 'assistant') history.pop()
  return history
}

/**
 * 构造 `chat` 客户端帧。text 会去掉首尾空白并截断到 8000 字符；
 * id 不合法时自动生成，保证返回结构始终可发送。
 */
export function buildChatRequest(messages, text, id) {
  const requestId = typeof id === 'string' && REQUEST_ID_RE.test(id) ? id : newRequestId()
  const message = (typeof text === 'string' ? text : '').trim().slice(0, MAX_MESSAGE_CHARS)
  return { type: 'chat', id: requestId, message, history: historyFromMessages(messages) }
}

/** 同源 WebSocket 地址：http→ws、https→wss，路径固定 /api/agent/chat。 */
export function chatSocketUrl(location) {
  try {
    let loc = location
    if (!loc || typeof loc !== 'object') {
      try {
        loc = globalThis.location
      } catch {
        loc = undefined
      }
    }
    if (!loc || typeof loc !== 'object') return ''
    const host = typeof loc.host === 'string' ? loc.host : ''
    if (!host) return ''
    const protocol = String(loc.protocol || '')
    const socketProtocol = protocol === 'https:' || protocol === 'wss:' ? 'wss' : 'ws'
    return `${socketProtocol}://${host}/api/agent/chat`
  } catch {
    return ''
  }
}

/** 解析服务端文本帧：非法 JSON / 非对象 / type 不在白名单 → null。 */
export function parseServerFrame(raw) {
  if (typeof raw !== 'string' || !raw) return null
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (typeof data.type !== 'string' || !SERVER_FRAME_TYPES.has(data.type)) return null
  return data
}

/** 生成符合 `^[A-Za-z0-9_-]{1,64}$` 的请求 id。 */
export function newRequestId() {
  try {
    const cryptoApi = globalThis.crypto
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      const value = cryptoApi.randomUUID()
      if (typeof value === 'string' && REQUEST_ID_RE.test(value)) return value
    }
  } catch {
    /* 不可用时走降级实现 */
  }
  const random = Math.random().toString(36).slice(2, 10)
  const value = `c_${Date.now().toString(36)}_${random}`
  return value.slice(0, 64)
}
