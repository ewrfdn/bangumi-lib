<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { checkSession } from '../auth'
import Icon from './Icon.vue'
import {
  MAX_MESSAGE_CHARS,
  appendTurn,
  buildChatRequest,
  chatSocketUrl,
  clearConversation,
  loadConversation,
  newRequestId,
  parseServerFrame,
  saveConversation,
  trimConversation,
} from '../agentChatStore'

/* ---------------------------------- 常量 ---------------------------------- */

const CONNECTION_LABELS = { idle: '未连接', connecting: '连接中', open: '已连接', closed: '已断开' }
const ADMIN_CONFIG_CODES = new Set(['AI_DISABLED', 'AI_NOT_CONFIGURED', 'AI_CONFIG_INVALID', 'AI_CONFIG_DECRYPTION_FAILED'])
const MAX_RECONNECT_ATTEMPTS = 6
const RECONNECT_BASE_DELAY = 1000
const RECONNECT_MAX_DELAY = 15000
const PING_INTERVAL = 45000
const ABORT_FALLBACK_DELAY = 8000
const TOOL_FALLBACK_LABEL = '执行操作'
const SUGGESTIONS = ['最近看了什么？', '帮我看看有没有扫描失败的任务', '媒体库里有哪些作品？']

/* ---------------------------------- 状态 ---------------------------------- */

const open = ref(false)
const messages = ref([])
const draft = ref('')
const sending = ref(false)
const stopRequested = ref(false)
const connection = ref('idle')
const ready = ref(null)
const fatalError = ref('')
const retryHint = ref(false)
const storageWarning = ref(false)
const activities = ref([])
const clearConfirm = ref(false)
const unread = ref(false)

const panelRef = ref(null)
const logRef = ref(null)
const inputRef = ref(null)
const toggleRef = ref(null)

let socket = null
let socketWasReady = false
let pendingId = null
let streamingIndex = -1
let reconnectAttempts = 0
let reconnectTimer = null
let pingTimer = null
let abortFallbackTimer = null
let probeToken = 0
let disposed = false

// 挂载时从 localStorage 恢复历史；损坏数据由 store 安全降级为空会话。
messages.value = loadConversation().messages

/* --------------------------------- 计算属性 -------------------------------- */

const aiDisabled = computed(() => Boolean(ready.value && ready.value.aiEnabled === false))
const connectionLabel = computed(() => CONNECTION_LABELS[connection.value] || CONNECTION_LABELS.closed)
const toolCount = computed(() => (Array.isArray(ready.value?.tools) ? ready.value.tools.length : 0))
const toolTooltip = computed(() =>
  (ready.value?.tools || []).map((tool) => tool?.label || tool?.name).filter(Boolean).join('、'),
)
const canInput = computed(() => !sending.value && !aiDisabled.value && !fatalError.value)
const canSend = computed(() => canInput.value && connection.value === 'open' && Boolean(draft.value.trim()))
const inputPlaceholder = computed(() => {
  if (fatalError.value) return '媒体助手暂不可用'
  if (aiDisabled.value) return '请先在后台启用模型服务'
  if (sending.value) return '正在生成回复…'
  if (connection.value === 'connecting') return '正在连接媒体助手…'
  if (connection.value === 'closed') return '连接已断开，可点击右上角重试'
  return '输入消息，Enter 发送'
})

/* --------------------------------- 渲染辅助 -------------------------------- */

/** 按行分段，识别简易代码块与列表前缀；纯文本渲染，绝不 v-html。 */
function segmentsOf(message) {
  const text = typeof message?.content === 'string' ? message.content : ''
  const segments = []
  let codeLines = null
  for (const raw of text.split('\n')) {
    if (raw.trim().startsWith('```')) {
      if (codeLines) {
        segments.push({ type: 'code', text: codeLines.join('\n') })
        codeLines = null
      } else {
        codeLines = []
      }
      continue
    }
    if (codeLines) {
      codeLines.push(raw)
      continue
    }
    const item = /^\s*(?:[-*•]|\d+[.、)])\s+/.test(raw)
    segments.push({ type: 'text', text: raw, item })
  }
  if (codeLines) segments.push({ type: 'code', text: codeLines.join('\n') })
  return segments
}

function toolText(tool) {
  const label = String(tool?.label || tool?.name || TOOL_FALLBACK_LABEL).replace(/^正在/, '')
  if (tool?.phase !== 'end') return `正在${label}…`
  if (tool.ok === false) return `${label}失败`
  const duration = Number.isFinite(tool.durationMs) ? `（${Math.max(1, Math.round(tool.durationMs))} ms）` : ''
  return `${label}完成${duration}`
}

/* --------------------------------- 本地持久化 ------------------------------- */

function persist() {
  const clean = messages.value
    .filter((message) => !message.streaming)
    .map((message) => ({ role: message.role, content: message.content, at: message.at, status: message.status }))
  storageWarning.value = !saveConversation({ version: 1, messages: clean })
}

function scrollToBottom() {
  const element = logRef.value
  if (!element) return
  element.scrollTop = element.scrollHeight
}

/* --------------------------------- WebSocket ------------------------------- */

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function startPing() {
  stopPing()
  pingTimer = setInterval(() => {
    if (!socket || socket.readyState !== 1) return
    try { socket.send(JSON.stringify({ type: 'ping' })) } catch { /* 连接已断开，交给 onclose */ }
  }, PING_INTERVAL)
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

function clearAbortFallback() {
  if (abortFallbackTimer) {
    clearTimeout(abortFallbackTimer)
    abortFallbackTimer = null
  }
}

function setFatal(message) {
  fatalError.value = message
  retryHint.value = false
  connection.value = 'closed'
  clearReconnect()
}

function scheduleReconnect() {
  if (disposed || !open.value || fatalError.value || reconnectTimer) return
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    connection.value = 'closed'
    retryHint.value = true
    return
  }
  reconnectAttempts += 1
  const delay = Math.min(RECONNECT_BASE_DELAY * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_DELAY)
  connection.value = 'connecting'
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!disposed && open.value && !fatalError.value) connect()
  }, delay)
}

/**
 * 浏览器 WebSocket 不暴露握手 HTTP 状态码，因此握手失败时用 /api/auth/session
 * 复核会话：未配置 AUTH_SECRET → 403 场景，未登录 → 401 场景，都不再重试。
 */
async function checkHandshake() {
  const token = ++probeToken
  connection.value = 'connecting'
  let session = null
  try { session = await checkSession(true) } catch { session = null }
  if (token !== probeToken || disposed || !open.value || socket || fatalError.value) return
  if (session && session.enabled === false) {
    setFatal('请先在服务端配置 AUTH_SECRET，登录后才能使用媒体助手。')
    return
  }
  if (session && session.authenticated === false) {
    setFatal('登录状态已失效，请先输入访问密钥登录，再重新连接媒体助手。')
    return
  }
  scheduleReconnect()
}

function connect() {
  if (disposed || !open.value || socket || fatalError.value) return
  if (typeof WebSocket === 'undefined') {
    setFatal('当前浏览器不支持 WebSocket，无法连接媒体助手。')
    return
  }
  const url = chatSocketUrl()
  if (!url) {
    setFatal('无法确定媒体助手地址，请刷新页面后重试。')
    return
  }
  let nextSocket
  try {
    nextSocket = new WebSocket(url)
  } catch {
    connection.value = 'closed'
    scheduleReconnect()
    return
  }
  socket = nextSocket
  socketWasReady = false
  connection.value = 'connecting'
  retryHint.value = false
  nextSocket.onopen = () => {
    if (socket !== nextSocket) return
    // 以 ready 帧为准再显示“已连接”，避免把半开连接误报为可用。
    connection.value = 'connecting'
  }
  nextSocket.onmessage = (event) => {
    if (socket !== nextSocket || disposed) return
    const frame = parseServerFrame(event.data)
    if (frame) handleFrame(frame)
  }
  nextSocket.onerror = () => { /* 统一由 onclose 处理重连/鉴权判定 */ }
  nextSocket.onclose = () => {
    if (socket !== nextSocket) return
    handleSocketClosed()
  }
}

function handleSocketClosed() {
  const hadReady = socketWasReady
  socket = null
  socketWasReady = false
  stopPing()
  clearReconnect()
  if (connection.value === 'open' || connection.value === 'connecting') connection.value = 'closed'
  abortLocalTurn()
  if (disposed || !open.value || fatalError.value) return
  if (hadReady || reconnectAttempts > 0) scheduleReconnect()
  else checkHandshake()
}

function disconnect() {
  probeToken += 1
  clearReconnect()
  stopPing()
  clearAbortFallback()
  const current = socket
  socket = null
  socketWasReady = false
  if (current) {
    try { current.close() } catch { /* 已关闭 */ }
  }
  connection.value = 'idle'
  abortLocalTurn()
  activities.value = []
}

function retryConnection() {
  fatalError.value = ''
  retryHint.value = false
  reconnectAttempts = 0
  probeToken += 1
  clearReconnect()
  stopPing()
  const current = socket
  socket = null
  socketWasReady = false
  if (current) {
    try { current.close() } catch { /* 已关闭 */ }
  }
  connection.value = 'idle'
  connect()
}

/* --------------------------------- 帧处理 --------------------------------- */

function handleFrame(frame) {
  switch (frame.type) {
    case 'ready':
      handleReady(frame)
      break
    case 'start':
      if (frame.id === pendingId) stopRequested.value = false
      break
    case 'delta':
      handleDelta(frame)
      break
    case 'tool':
      handleTool(frame)
      break
    case 'done':
      handleDone(frame)
      break
    case 'error':
      handleErrorFrame(frame)
      break
    case 'aborted':
      handleAborted(frame)
      break
    default:
      break // pong：保活应答，无需处理
  }
}

function handleReady(frame) {
  const tools = Array.isArray(frame.tools) ? frame.tools.filter((tool) => tool && typeof tool === 'object') : []
  ready.value = {
    aiEnabled: frame.aiEnabled !== false,
    model: typeof frame.model === 'string' && frame.model ? frame.model : '',
    tools,
  }
  connection.value = 'open'
  socketWasReady = true
  reconnectAttempts = 0
  retryHint.value = false
  fatalError.value = ''
  startPing()
}

function handleDelta(frame) {
  if (!sending.value || frame.id !== pendingId || typeof frame.text !== 'string' || !frame.text) return
  const index = streamingIndex
  const current = messages.value[index]
  if (index < 0 || !current) return
  messages.value[index] = { ...current, content: `${current.content}${frame.text}` }
}

function handleTool(frame) {
  if (!sending.value || frame.id !== pendingId) return
  const key = typeof frame.toolCallId === 'string' && frame.toolCallId ? frame.toolCallId : `${frame.name || 'tool'}-${activities.value.length}`
  const index = activities.value.findIndex((item) => item.key === key && item.phase !== 'end')
  if (frame.phase === 'end') {
    const finished = {
      key,
      name: frame.name,
      label: frame.label,
      phase: 'end',
      ok: frame.ok !== false,
      durationMs: frame.durationMs,
    }
    if (index >= 0) {
      const next = activities.value.slice()
      next[index] = { ...next[index], ...finished }
      activities.value = next
    } else {
      activities.value = [...activities.value, finished].slice(-8)
    }
    return
  }
  activities.value = [
    ...activities.value,
    { key, name: frame.name, label: frame.label, phase: 'start', ok: null },
  ].slice(-8)
}

function handleDone(frame) {
  if (!sending.value || frame.id !== pendingId) return
  const partial = streamingIndex >= 0 && messages.value[streamingIndex] ? messages.value[streamingIndex].content : ''
  finalizeTurn('ok', { content: typeof frame.text === 'string' ? frame.text : partial })
}

function handleErrorFrame(frame) {
  const message = typeof frame.message === 'string' && frame.message ? frame.message : '助手暂时无法回复，请稍后重试。'
  const code = typeof frame.code === 'string' ? frame.code : ''
  const showAdmin = ADMIN_CONFIG_CODES.has(code)
  if (sending.value) {
    if (frame.id && frame.id !== pendingId) return // 上一轮请求的迟到错误，忽略
    const current = streamingIndex >= 0 ? messages.value[streamingIndex] : null
    const partial = typeof current?.content === 'string' ? current.content : ''
    finalizeErrorTurn(partial, message, showAdmin)
    return
  }
  // 同一协议级错误（例如握手后 ready 失败）在自动重连期间会重复下发，避免刷屏。
  const last = messages.value[messages.value.length - 1]
  if (last && last.role === 'assistant' && last.status === 'error' && last.content === message) return
  messages.value = [...messages.value, { role: 'assistant', content: message, at: Date.now(), status: 'error', showAdmin }]
  messages.value = trimConversation(messages.value)
  persist()
  scrollToBottom()
}

function finalizeErrorTurn(partial, message, showAdmin) {
  finalizeTurn('error', {
    content: partial || message,
    error: partial ? message : '',
    showAdmin,
  })
}

function handleAborted(frame) {
  if (!sending.value) return
  if (frame.id && frame.id !== pendingId) return
  const partial = streamingIndex >= 0 && messages.value[streamingIndex] ? messages.value[streamingIndex].content : ''
  finalizeTurn('aborted', { content: typeof partial === 'string' ? partial : '' })
}

function finalizeTurn(status, { content, error = '', showAdmin = false } = {}) {
  const index = streamingIndex
  const now = Date.now()
  if (index >= 0 && messages.value[index] && messages.value[index].role === 'assistant') {
    const current = messages.value[index]
    messages.value[index] = {
      ...current,
      at: Number.isFinite(current.at) ? current.at : now,
      content: typeof content === 'string' ? content : current.content,
      status,
      streaming: false,
      error,
      showAdmin: Boolean(showAdmin),
    }
  } else if (status) {
    messages.value = [
      ...messages.value,
      { role: 'assistant', content: typeof content === 'string' ? content : '', at: now, status, error, showAdmin: Boolean(showAdmin) },
    ]
  }
  streamingIndex = -1
  pendingId = null
  sending.value = false
  stopRequested.value = false
  activities.value = []
  clearAbortFallback()
  messages.value = trimConversation(messages.value)
  persist()
  scrollToBottom()
  // 面板已收起时在后台完成的一轮：标记未读并断开空闲连接，不自动重连。
  if (!open.value) {
    unread.value = true
    disconnect()
  }
}

function abortLocalTurn() {
  clearAbortFallback()
  if (!sending.value) return
  const partial = streamingIndex >= 0 && messages.value[streamingIndex] ? messages.value[streamingIndex].content : ''
  finalizeTurn('aborted', { content: typeof partial === 'string' ? partial : '' })
}

/* --------------------------------- 发送控制 -------------------------------- */

function send() {
  if (!canSend.value) return
  const text = draft.value.trim().slice(0, MAX_MESSAGE_CHARS)
  if (!text) return
  if (!socket || socket.readyState !== 1) {
    connection.value = 'closed'
    scheduleReconnect()
    return
  }
  // history 必须基于"本轮发送前"的消息，服务端把 message 当作最新 user 轮。
  const request = buildChatRequest(messages.value, text, newRequestId())
  draft.value = ''
  resetInputHeight()
  sending.value = true
  stopRequested.value = false
  activities.value = []
  const at = Date.now()
  messages.value = appendTurn(messages.value, { role: 'user', content: text, at, status: 'ok' })
  messages.value = [...messages.value, { role: 'assistant', content: '', at, status: 'ok', streaming: true }]
  streamingIndex = messages.value.length - 1
  pendingId = request.id
  persist() // 用户消息立即落本地；流式占位不持久化，避免刷新后出现空回复
  scrollToBottom()
  nextTick(() => inputRef.value?.focus())
  try {
    socket.send(JSON.stringify({ type: 'chat', id: request.id, message: request.message, history: request.history }))
  } catch {
    finalizeTurn('error', { content: '消息发送失败，请检查网络后重试。' })
  }
}

function stop() {
  if (!sending.value || stopRequested.value) return
  stopRequested.value = true
  if (socket && socket.readyState === 1) {
    try {
      socket.send(JSON.stringify({ type: 'abort', ...(pendingId ? { id: pendingId } : {}) }))
    } catch {
      finalizeTurn('aborted', {})
      return
    }
    // 服务端应回 aborted；网络异常时兜底本地收尾，避免一直停在“正在生成”。
    clearAbortFallback()
    abortFallbackTimer = setTimeout(() => {
      abortFallbackTimer = null
      if (sending.value) abortLocalTurn()
    }, ABORT_FALLBACK_DELAY)
    return
  }
  finalizeTurn('aborted', {})
}

function onInputKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey) return
  if (event.isComposing || event.keyCode === 229) return // 中文输入法候选确认
  event.preventDefault()
  send()
}

function resizeInput() {
  const element = inputRef.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 108)}px`
}

function resetInputHeight() {
  const element = inputRef.value
  if (element) element.style.height = 'auto'
}

function pickSuggestion(text) {
  draft.value = text
  nextTick(() => {
    inputRef.value?.focus()
    resizeInput()
  })
}

/* --------------------------------- 面板控制 -------------------------------- */

function openPanel() {
  open.value = true
  clearConfirm.value = false
  unread.value = false
  if (!fatalError.value) connect()
  nextTick(() => {
    scrollToBottom()
    inputRef.value?.focus()
  })
}

function closePanel() {
  open.value = false
  clearConfirm.value = false
  // 生成中可以收起面板让这一轮在后台完成（完成后打未读点并断开连接）；
  // 空闲时立即断开，且关闭面板后 socket 不再触发重连。
  if (!sending.value) disconnect()
  nextTick(() => toggleRef.value?.focus())
}

function togglePanel() {
  if (open.value) closePanel()
  else openPanel()
}

function askClear() {
  if (!messages.value.length) return
  clearConfirm.value = true
}

function cancelClear() {
  clearConfirm.value = false
  nextTick(() => inputRef.value?.focus())
}

function doClear() {
  if (sending.value) {
    if (socket && socket.readyState === 1) {
      try { socket.send(JSON.stringify({ type: 'abort', ...(pendingId ? { id: pendingId } : {}) })) } catch { /* ignore */ }
    }
  }
  clearAbortFallback()
  clearConversation()
  storageWarning.value = false
  clearConfirm.value = false
  messages.value = []
  activities.value = []
  streamingIndex = -1
  pendingId = null
  sending.value = false
  stopRequested.value = false
  if (open.value) nextTick(() => inputRef.value?.focus())
}

/* --------------------------------- 生命周期 -------------------------------- */

function onWindowKeydown(event) {
  if (!open.value || event.key !== 'Escape') return
  // 手柄/键盘面板等游戏手柄覆盖层打开时不抢 Escape。
  if (typeof document !== 'undefined' && document.querySelector('[data-gp-overlay]')) return
  event.stopPropagation()
  if (clearConfirm.value) {
    cancelClear()
    return
  }
  closePanel()
}

function onUnauthorized() {
  probeToken += 1
  clearReconnect()
  stopPing()
  clearAbortFallback()
  const current = socket
  socket = null
  socketWasReady = false
  if (current) {
    try { current.close() } catch { /* 已关闭 */ }
  }
  connection.value = 'closed'
  abortLocalTurn()
  fatalError.value = '登录状态已失效，请重新登录后使用媒体助手。'
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('anishare:unauthorized', onUnauthorized)
})

onBeforeUnmount(() => {
  disposed = true
  probeToken += 1
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('anishare:unauthorized', onUnauthorized)
  clearReconnect()
  stopPing()
  if (sending.value) abortLocalTurn() // 关闭组件前把进行中的一轮标记为已停止并落本地
  clearAbortFallback()
  const current = socket
  socket = null
  socketWasReady = false
  if (current) {
    try { current.close() } catch { /* 已关闭 */ }
  }
})

watch(
  messages,
  () => {
    if (open.value) nextTick(scrollToBottom)
  },
  { deep: true, flush: 'post' },
)
watch(
  activities,
  () => {
    if (open.value) nextTick(scrollToBottom)
  },
  { deep: true, flush: 'post' },
)
</script>

<template>
  <div class="agent-chat">
    <transition name="agent-pop">
      <section v-if="open" id="agent-chat-panel" ref="panelRef" class="chat-panel" role="dialog" aria-label="媒体助手">
        <header class="chat-head">
          <span class="chat-avatar" aria-hidden="true"><Icon name="sparkles" :size="17" /></span>
          <div class="chat-heading">
            <strong>媒体助手</strong>
            <span class="chat-meta">
              <span class="status-dot" :class="connection === 'open' ? 'open' : connection" aria-hidden="true" />
              <span>{{ connectionLabel }}</span>
              <template v-if="ready && ready.model"><span aria-hidden="true">·</span><span class="model" :title="ready.model">{{ ready.model }}</span></template>
              <template v-if="toolCount"><span aria-hidden="true">·</span><span :title="toolTooltip">{{ toolCount }} 个工具</span></template>
            </span>
          </div>
          <div class="chat-actions">
            <button type="button" class="icon-button" aria-label="清空对话" title="清空对话" :disabled="!messages.length" @click="askClear"><Icon name="trash" :size="15" /></button>
            <button type="button" class="icon-button" aria-label="关闭媒体助手" title="关闭" @click="closePanel"><Icon name="close" :size="16" /></button>
          </div>
        </header>

        <div v-if="clearConfirm" class="confirm-bar" role="alertdialog" aria-label="确认清空对话">
          <span>清空全部本地对话？此操作不可恢复。</span>
          <button type="button" class="btn small" @click="cancelClear">取消</button>
          <button type="button" class="btn small danger" @click="doClear">清空</button>
        </div>

        <div v-if="fatalError" class="notice-bar err" role="alert">
          <span>{{ fatalError }}</span>
          <button type="button" class="btn small" @click="retryConnection">重新连接</button>
        </div>
        <div v-else-if="aiDisabled" class="notice-bar" role="status">
          <span>模型服务尚未启用，请先在后台配置并启用模型。</span>
          <a href="/admin?tab=ai">去配置模型</a>
        </div>
        <div v-else-if="retryHint" class="notice-bar err" role="alert">
          <span>与助手的连接已断开。</span>
          <button type="button" class="btn small" @click="retryConnection">重试</button>
        </div>
        <div v-if="storageWarning" class="notice-bar subtle" role="status">
          <span>当前浏览器无法保存对话，刷新页面后会丢失记录。</span>
        </div>

        <div ref="logRef" class="chat-log" role="log" aria-live="polite" aria-relevant="additions text">
          <div v-if="!messages.length" class="chat-welcome">
            <span class="welcome-icon" aria-hidden="true"><Icon name="sparkles" :size="22" /></span>
            <p>你好，我是媒体助手。<br />可以帮你查询媒体库、观看进度与任务，也能在你确认范围后触发扫描或整理归档。</p>
            <div class="suggestions">
              <button v-for="suggestion in SUGGESTIONS" :key="suggestion" type="button" class="suggestion" @click="pickSuggestion(suggestion)">{{ suggestion }}</button>
            </div>
            <p class="welcome-note">对话只保存在当前浏览器，不会写入服务端。</p>
          </div>

          <article v-for="(message, index) in messages" :key="index" class="message" :class="[message.role, message.status, { streaming: message.streaming }]">
            <div class="bubble">
              <span v-if="message.streaming && !message.content" class="typing" aria-label="正在生成回复"><i /><i /><i /></span>
              <template v-else>
                <template v-for="(segment, segmentIndex) in segmentsOf(message)" :key="segmentIndex">
                  <pre v-if="segment.type === 'code'" class="code-block">{{ segment.text }}</pre>
                  <div v-else class="text-line" :class="{ blank: !segment.text, item: segment.item }">{{ segment.text || '\u00A0' }}</div>
                </template>
              </template>
              <div v-if="message.status === 'aborted'" class="msg-note">已停止生成</div>
              <div v-else-if="message.status === 'error'" class="msg-note err">
                <template v-if="message.error">{{ message.error }}</template>
                <template v-else-if="!message.content">助手暂时无法回复，请稍后重试。</template>
                <template v-else>回复中断</template>
                <a v-if="message.showAdmin" href="/admin?tab=ai">去配置模型</a>
              </div>
            </div>
          </article>

          <div v-if="activities.length && sending" class="tool-list" aria-live="polite">
            <div v-for="tool in activities" :key="tool.key" class="tool-row" :class="{ running: tool.phase !== 'end', done: tool.phase === 'end', failed: tool.phase === 'end' && tool.ok === false }">
              <span class="tool-indicator" aria-hidden="true">
                <span v-if="tool.phase !== 'end'" class="tool-spinner" />
                <Icon v-else :name="tool.ok === false ? 'close' : 'check'" :size="11" />
              </span>
              <span>{{ toolText(tool) }}</span>
            </div>
          </div>
        </div>

        <form class="chat-input" @submit.prevent="send">
          <textarea
            ref="inputRef"
            v-model="draft"
            rows="1"
            :maxlength="MAX_MESSAGE_CHARS"
            :placeholder="inputPlaceholder"
            :disabled="!canInput"
            aria-label="输入消息"
            @input="resizeInput"
            @keydown="onInputKeydown"
          />
          <button v-if="sending" type="button" class="round-button stop" :disabled="stopRequested" aria-label="停止生成" title="停止生成" @click="stop">
            <Icon name="stop" :size="15" />
          </button>
          <button v-else type="submit" class="round-button" :disabled="!canSend" aria-label="发送消息" title="发送（Enter）">
            <Icon name="send" :size="16" />
          </button>
        </form>
        <footer class="chat-foot">
          <span>对话仅保存在此浏览器</span>
          <span v-if="toolCount" :title="toolTooltip">{{ toolCount }} 个可用工具</span>
        </footer>
      </section>
    </transition>

    <button
      ref="toggleRef"
      type="button"
      class="chat-toggle"
      :class="{ open }"
      :aria-label="open ? '关闭媒体助手' : unread ? '打开媒体助手（有新回复）' : '打开媒体助手'"
      :aria-expanded="open"
      aria-controls="agent-chat-panel"
      :title="open ? '关闭媒体助手' : '打开媒体助手'"
      @click="togglePanel"
    >
      <Icon :name="open ? 'close' : 'message'" :size="21" />
      <span v-if="sending" class="busy-dot" aria-hidden="true" />
      <span v-else-if="unread" class="unread-dot" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.agent-chat {
  position: fixed;
  right: max(16px, env(safe-area-inset-right));
  bottom: max(16px, env(safe-area-inset-bottom));
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  font-size: 13px;
}

.chat-toggle {
  position: relative;
  width: 48px;
  height: 48px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: var(--grad);
  border: 1px solid #b29af566;
  box-shadow: 0 10px 30px #00000073, 0 0 0 4px #a78bfa10;
  transition: transform .16s ease, background .16s ease, box-shadow .16s ease;
}
.chat-toggle:hover { transform: translateY(-2px); box-shadow: 0 13px 34px #0000008a, 0 0 0 5px #a78bfa14; }
.chat-toggle.open { background: #1a1a23; color: var(--text); border-color: var(--line-strong); box-shadow: 0 10px 30px #00000073; }
.busy-dot { position: absolute; top: 6px; right: 6px; width: 8px; height: 8px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 2px #9c7cf4; animation: agent-pulse 1.3s ease-in-out infinite; }
.unread-dot { position: absolute; top: 7px; right: 7px; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px #121218, 0 0 8px #a78bfa; }

.chat-panel {
  width: min(400px, calc(100vw - 24px));
  height: min(560px, calc(100vh - 110px));
  height: min(560px, calc(100dvh - 110px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: #121218f5;
  box-shadow: var(--shadow);
  backdrop-filter: blur(18px);
}
.agent-pop-enter-active, .agent-pop-leave-active { transition: opacity .14s ease, transform .14s ease; }
.agent-pop-enter-from, .agent-pop-leave-to { opacity: 0; transform: translateY(8px) scale(.98); transform-origin: bottom right; }

.chat-head { flex: none; display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, #17171f, #121218); }
.chat-avatar { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 9px; color: #d6c6ff; background: #a78bfa17; border: 1px solid #a78bfa30; }
.chat-heading { flex: 1; min-width: 0; }
.chat-heading strong { display: block; font-size: 13px; font-weight: 600; letter-spacing: -.2px; }
.chat-meta { display: flex; align-items: center; gap: 5px; margin-top: 3px; color: var(--text-faint); font-size: 10px; white-space: nowrap; overflow: hidden; }
.chat-meta .model { max-width: 112px; overflow: hidden; text-overflow: ellipsis; }
.status-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: #6f6b7c; }
.status-dot.open { background: #a78bfa; box-shadow: 0 0 6px #a78bfa; }
.status-dot.connecting { background: var(--warn); animation: agent-pulse 1.2s ease-in-out infinite; }
.status-dot.closed { background: var(--err); }
.chat-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border-radius: 6px; color: var(--text-faint); transition: background .15s, color .15s; }
.icon-button:hover:not(:disabled) { color: var(--text); background: #ffffff0c; }
.icon-button:disabled { opacity: .35; }

.confirm-bar { flex: none; display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid #e594a125; background: #e594a10a; color: #efb0b9; font-size: 11px; }
.confirm-bar span { flex: 1; min-width: 0; }
.btn.danger { color: #efb0b9; border-color: #e594a140; background: #e594a110; }

.notice-bar { flex: none; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; padding: 9px 12px; border-bottom: 1px solid var(--line); background: #a78bfa08; color: #c8b8ee; font-size: 11px; line-height: 1.7; }
.notice-bar.err { background: #e594a109; color: #efb0b9; }
.notice-bar.subtle { background: #ffffff04; color: var(--text-faint); }
.notice-bar a { color: #d6c6ff; text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
.notice-bar .btn { min-height: 24px; padding: 0 8px; font-size: 10px; }

.chat-log { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 14px 12px 10px; display: flex; flex-direction: column; gap: 10px; }
.chat-welcome { margin: auto 4px; text-align: center; color: var(--text-dim); font-size: 12px; line-height: 1.85; }
.welcome-icon { display: grid; place-items: center; width: 40px; height: 40px; margin: 0 auto 12px; border-radius: 12px; color: var(--accent); background: #a78bfa0f; border: 1px solid #a78bfa25; }
.chat-welcome p { margin: 0; }
.chat-welcome .welcome-note { margin-top: 12px; color: var(--text-faint); font-size: 10px; }
.suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 15px; }
.suggestion { padding: 6px 10px; border-radius: 999px; border: 1px solid var(--line-strong); background: #ffffff05; color: var(--text-dim); font-size: 11px; transition: border-color .15s, color .15s, background .15s; }
.suggestion:hover { color: #d6c6ff; border-color: #a78bfa50; background: #a78bfa0d; }

.message { display: flex; }
.message.user { justify-content: flex-end; }
.message.assistant { justify-content: flex-start; }
.bubble { max-width: 86%; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line); background: #191922; color: var(--text); font-size: 12px; line-height: 1.75; overflow-wrap: anywhere; }
.message.user .bubble { background: linear-gradient(135deg, #a78bfa2e, #8b6ae826); border-color: #a78bfa40; color: #f2eeff; border-bottom-right-radius: 4px; }
.message.assistant .bubble { border-bottom-left-radius: 4px; }
.message.assistant.error .bubble { border-color: #e594a140; background: #e594a10c; }
.message.assistant.aborted .bubble { opacity: .85; border-style: dashed; }
.text-line { white-space: pre-wrap; }
.text-line.blank { height: .55em; }
.text-line.item { padding-left: 1em; text-indent: -.6em; }
.code-block { margin: 6px 0; padding: 8px 10px; max-height: 220px; overflow: auto; border-radius: 6px; border: 1px solid var(--line); background: #08080d; font: 11px/1.7 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg-note { margin-top: 6px; font-size: 10px; color: var(--text-faint); }
.msg-note.err { color: #efb0b9; }
.msg-note a { margin-left: 6px; color: #d6c6ff; text-decoration: underline; }
.typing { display: inline-flex; align-items: center; gap: 4px; height: 15px; }
.typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: agent-bounce 1s ease-in-out infinite; }
.typing i:nth-child(2) { animation-delay: .15s; }
.typing i:nth-child(3) { animation-delay: .3s; }

.tool-list { display: flex; flex-direction: column; gap: 5px; padding: 2px 4px 0; }
.tool-row { display: flex; align-items: center; gap: 6px; color: var(--text-faint); font-size: 10.5px; line-height: 1.6; }
.tool-row.running { color: #c5b2fa; }
.tool-row.failed { color: #e7a7b2; }
.tool-indicator { display: inline-flex; width: 11px; justify-content: center; flex: none; }
.tool-spinner { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid #a78bfa25; border-top-color: var(--accent); animation: spin .8s linear infinite; }

.chat-input { flex: none; display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); background: #101017; }
.chat-input textarea { flex: 1; min-width: 0; min-height: 36px; max-height: 108px; padding: 9px 11px; border-radius: 9px; border: 1px solid #ffffff1c; background: #0b0b11; color: var(--text); font: inherit; font-size: 12px; line-height: 1.55; outline: none; resize: none; overflow-y: auto; transition: border-color .15s; }
.chat-input textarea:focus { border-color: #a78bfa85; }
.chat-input textarea::placeholder { color: #696575; }
.chat-input textarea:disabled { opacity: .6; }
.round-button { flex: none; width: 36px; height: 36px; display: grid; place-items: center; padding: 0; border-radius: 50%; color: #fff; background: #9c7cf4; transition: background .15s, transform .15s; }
.round-button:hover:not(:disabled) { background: #ad90ff; transform: translateY(-1px); }
.round-button:disabled { opacity: .35; }
.round-button.stop { background: #2a2436; border: 1px solid #a78bfa40; color: #d6c6ff; }
.round-button.stop:hover:not(:disabled) { background: #352c45; }
.chat-foot { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 12px 9px; color: var(--text-faint); font-size: 10px; }

@keyframes agent-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes agent-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: .55; } 40% { transform: translateY(-3px); opacity: 1; } }

@media (max-width: 480px) {
  .agent-chat { right: 12px; bottom: 12px; }
  .chat-panel { width: calc(100vw - 24px); height: min(560px, calc(100vh - 96px)); height: min(560px, calc(100dvh - 96px)); border-radius: 12px; }
  .bubble { max-width: 90%; }
}
</style>
