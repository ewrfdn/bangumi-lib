import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAT_STORAGE_KEY,
  MAX_CHARS,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  appendTurn,
  buildChatRequest,
  chatSocketUrl,
  clearConversation,
  emptyConversation,
  loadConversation,
  newRequestId,
  parseServerFrame,
  saveConversation,
  trimConversation,
} from '../src/agentChatStore.js'

/** 最小的内存版 Storage，行为与浏览器 localStorage 接近。 */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    keys: () => [...map.keys()],
    raw: (key) => (map.has(key) ? map.get(key) : null),
  }
}

const msg = (role, content, at = 1000, status = 'ok') => ({ role, content, at, status })
const conversation = (messages) => ({ version: 1, updatedAt: 2000, messages })

let storage
beforeEach(() => {
  storage = memoryStorage()
  globalThis.localStorage = storage
})
afterEach(() => {
  try { delete globalThis.localStorage } catch { /* ignore */ }
  try { delete globalThis.location } catch { /* ignore */ }
})

test('saveConversation / loadConversation round-trip keeps messages and version', () => {
  const messages = [msg('user', '最近看了什么？'), msg('assistant', '你在看《葬送的芙莉莲》。')]
  assert.equal(saveConversation(conversation(messages), storage), true)
  const raw = JSON.parse(storage.raw(CHAT_STORAGE_KEY))
  assert.equal(raw.version, 1)
  assert.equal(typeof raw.updatedAt, 'number')
  assert.equal(raw.updatedAt > 0, true)
  const loaded = loadConversation(storage)
  assert.equal(loaded.version, 1)
  assert.equal(loaded.updatedAt, raw.updatedAt)
  assert.deepEqual(loaded.messages, messages)
})

test('loadConversation falls back to an empty conversation for corrupt or mismatched data', () => {
  const badPayloads = [
    '{not json',
    'null',
    '[]',
    '"text"',
    '42',
    JSON.stringify({ version: 2, messages: [] }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, messages: {} }),
    JSON.stringify({ version: 1, messages: [msg('system', 'hi')] }),
    JSON.stringify({ version: 1, messages: [msg('user', 42)] }),
    JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'hi', at: 'now', status: 'ok' }] }),
    JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'hi', at: 1, status: 'pending' }] }),
    JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'hi', status: 'ok' }] }),
    JSON.stringify({ version: 1, messages: null }),
  ]
  for (const payload of badPayloads) {
    storage.setItem(CHAT_STORAGE_KEY, payload)
    assert.deepEqual(loadConversation(storage), emptyConversation(), payload)
  }
  // 单条坏消息导致整段数据按空会话处理（文档要求"读取到损坏数据按空会话处理"）。
  storage.setItem(CHAT_STORAGE_KEY, JSON.stringify(conversation([msg('user', 'ok'), { role: 'user', content: 3, at: 1, status: 'ok' }])))
  assert.deepEqual(loadConversation(storage).messages, [])
})

test('storage being unavailable or throwing degrades safely', () => {
  const throwing = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  assert.deepEqual(loadConversation(throwing), emptyConversation())
  assert.equal(saveConversation(conversation([]), throwing), false)
  assert.equal(clearConversation(throwing), false)

  const quota = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError') },
    removeItem: () => {},
  }
  assert.equal(saveConversation(conversation([msg('user', 'hi')]), quota), false)

  // 完全没有 storage（无参数 + 无 globalThis.localStorage）。
  delete globalThis.localStorage
  assert.deepEqual(loadConversation(), emptyConversation())
  assert.equal(saveConversation(conversation([msg('user', 'hi')])), false)
  assert.equal(clearConversation(), false)

  // storage 对象本身的属性读取抛错也不能冒泡。
  const hostile = { get getItem() { throw new Error('blocked') } }
  assert.deepEqual(loadConversation(hostile), emptyConversation())
  assert.equal(clearConversation(hostile), false)
})

test('saveConversation ignores malformed entries and trims to the local cap', () => {
  assert.equal(saveConversation(null, storage), false)
  assert.equal(saveConversation({ messages: 'nope' }, storage), false)

  const mixed = conversation([
    msg('user', '保留'),
    { role: 'system', content: '丢弃' },
    { role: 'assistant', content: 7, at: 1, status: 'ok' },
    msg('assistant', '也保留'),
  ])
  assert.equal(saveConversation(mixed, storage), true)
  assert.deepEqual(loadConversation(storage).messages.map((item) => item.content), ['保留', '也保留'])

  const many = []
  for (let index = 0; index < 60; index += 1) {
    many.push(msg('user', `问 ${index}`))
    many.push(msg('assistant', `答 ${index}`))
  }
  assert.equal(saveConversation(conversation(many), storage), true)
  const stored = JSON.parse(storage.raw(CHAT_STORAGE_KEY))
  assert.equal(stored.messages.length, MAX_MESSAGES)
  assert.equal(stored.messages[0].content, '问 10')
  assert.equal(loadConversation(storage).messages.length, MAX_MESSAGES)
})

test('clearConversation removes the key and load returns an empty conversation', () => {
  saveConversation(conversation([msg('user', 'hi')]), storage)
  assert.equal(clearConversation(storage), true)
  assert.equal(storage.getItem(CHAT_STORAGE_KEY), null)
  assert.deepEqual(loadConversation(storage), emptyConversation())
})

test('appendTurn is pure and validates its input', () => {
  const original = [msg('user', '你好')]
  const next = appendTurn(original, { role: 'assistant', content: '你好呀' })
  assert.notEqual(next, original)
  assert.equal(original.length, 1)
  assert.equal(next.length, 2)
  assert.equal(next[1].role, 'assistant')
  assert.equal(next[1].status, 'ok')
  assert.equal(typeof next[1].at, 'number')

  assert.deepEqual(appendTurn(original, { role: 'tool', content: 'x' }), original)
  assert.deepEqual(appendTurn(original, null), original)

  const fromNull = appendTurn(null, { role: 'user', content: 'x' })
  assert.equal(fromNull.length, 1)
  assert.equal(fromNull[0].role, 'user')
  assert.equal(fromNull[0].content, 'x')
  assert.equal(fromNull[0].status, 'ok')
  assert.equal(typeof fromNull[0].at, 'number')
})

test('appendTurn accepts error and aborted statuses for local display', () => {
  const next = appendTurn([], { role: 'assistant', content: '失败', status: 'error', at: 5 })
  assert.equal(next.length, 1)
  assert.equal(next[0].status, 'error')
  assert.equal(next[0].at, 5)
  const aborted = appendTurn(next, { role: 'assistant', content: '', status: 'aborted' })
  assert.equal(aborted[1].status, 'aborted')
})

test('trimConversation drops the oldest whole turns to respect message and character caps', () => {
  const turns = []
  for (let index = 0; index < 60; index += 1) {
    turns.push(msg('user', `问题 ${index}`))
    turns.push(msg('assistant', `回答 ${index}`))
  }
  const byCount = trimConversation(turns, { maxMessages: MAX_MESSAGES, maxChars: Number.MAX_SAFE_INTEGER })
  assert.equal(byCount.length, MAX_MESSAGES)
  assert.equal(byCount[0].role, 'user')
  assert.equal(byCount[0].content, '问题 10')

  const longTurns = []
  for (let index = 0; index < 30; index += 1) {
    longTurns.push(msg('user', 'u'.repeat(5000)))
    longTurns.push(msg('assistant', 'a'.repeat(5000)))
  }
  const byChars = trimConversation(longTurns, { maxMessages: MAX_MESSAGES, maxChars: MAX_CHARS })
  const total = byChars.reduce((sum, item) => sum + item.content.length, 0)
  assert.equal(total <= MAX_CHARS, true)
  assert.equal(byChars.length, 20)
  assert.equal(byChars[0].role, 'user')

  assert.deepEqual(trimConversation(null), [])
  assert.deepEqual(trimConversation([null, 3, 'x']), [])
  // 异常 options 也安全降级为默认上限。
  assert.equal(trimConversation(turns, null).length, MAX_MESSAGES)
  assert.equal(trimConversation(turns, 'bad').length, MAX_MESSAGES)

  // 保留展示用的额外字段（正在流式/错误提示等）。
  const extra = trimConversation([{ ...msg('user', 'hi'), streaming: true }])
  assert.equal(extra.length, 1)
})

test('buildChatRequest filters history to non-empty successful turns and ends with assistant', () => {
  const messages = [
    msg('user', '你好'),
    msg('assistant', '你好，我是媒体助手'),
    msg('user', '最近看了什么'),
    msg('assistant', '查询失败', 1, 'error'),
    msg('user', '那看看任务'),
    msg('assistant', '被中止', 1, 'aborted'),
    msg('user', '还没回复'),
  ]
  const request = buildChatRequest(messages, '  帮我扫描一下  ', 'req-1')
  assert.equal(request.type, 'chat')
  assert.equal(request.id, 'req-1')
  assert.equal(request.message, '帮我扫描一下')
  assert.deepEqual(request.history, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，我是媒体助手' },
  ])

  const emptyRequest = buildChatRequest([], '   ', 'req-2')
  assert.equal(emptyRequest.message, '')
  assert.deepEqual(emptyRequest.history, [])

  // 正文为空的 ok 轮次不进入历史。
  assert.deepEqual(
    buildChatRequest([msg('user', 'a'), msg('assistant', ''), msg('user', 'b'), msg('assistant', 'c')], 'x', 'id').history,
    [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }],
  )
})

test('buildChatRequest caps history at 40 messages and keeps chronological order', () => {
  const messages = []
  for (let index = 1; index <= 30; index += 1) {
    messages.push(msg('user', `u${index}`, index))
    messages.push(msg('assistant', `a${index}`, index))
  }
  const request = buildChatRequest(messages, 'next', 'req-3')
  assert.equal(MAX_HISTORY_MESSAGES, 40)
  assert.equal(request.history.length, 40)
  assert.equal(request.history[0].content, 'u11')
  assert.equal(request.history[request.history.length - 1].content, 'a30')
})

test('buildChatRequest caps history characters from the newest message backwards', () => {
  const messages = []
  for (let index = 1; index <= 6; index += 1) {
    messages.push(msg('user', `${index}`.padEnd(5000, 'u')))
    messages.push(msg('assistant', `${index}`.padEnd(5000, 'a')))
  }
  const request = buildChatRequest(messages, 'next', 'req-4')
  const total = request.history.reduce((sum, item) => sum + item.content.length, 0)
  assert.equal(total <= MAX_HISTORY_CHARS, true)
  assert.equal(request.history.length, 9)
  assert.equal(request.history[request.history.length - 1].content.startsWith('6'), true)
})

test('buildChatRequest truncates long messages and generates a valid id when needed', () => {
  const request = buildChatRequest([], 'x'.repeat(9000), 'id with spaces!')
  assert.equal(request.message.length, MAX_MESSAGE_CHARS)
  const generated = newRequestId()
  assert.match(request.id, /^[A-Za-z0-9_-]{1,64}$/)
  assert.notEqual(request.id, 'id with spaces!')
  assert.ok(generated.length <= 64)

  const longHistory = buildChatRequest([msg('user', 'y'.repeat(9000))], 'next', 'req-5')
  assert.equal(longHistory.history.length, 0) // 末尾 user 轮被去掉
  const longAssistant = buildChatRequest([msg('user', '短'), msg('assistant', 'z'.repeat(9000))], 'next', 'req-6')
  assert.equal(longAssistant.history[1].content.length, MAX_MESSAGE_CHARS)
})

test('newRequestId produces unique URL-safe ids', () => {
  const ids = new Set()
  for (let index = 0; index < 50; index += 1) {
    const id = newRequestId()
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/)
    ids.add(id)
  }
  assert.equal(ids.size, 50)
})

test('chatSocketUrl maps http to ws and https to wss on the same origin', () => {
  assert.equal(chatSocketUrl({ protocol: 'http:', host: 'example.com' }), 'ws://example.com/api/agent/chat')
  assert.equal(chatSocketUrl({ protocol: 'https:', host: 'example.com:8443' }), 'wss://example.com:8443/api/agent/chat')
  assert.equal(chatSocketUrl({ protocol: 'http:', host: 'localhost:6001' }), 'ws://localhost:6001/api/agent/chat')
  assert.equal(chatSocketUrl({}), '')
  assert.equal(chatSocketUrl(null), '')
  assert.equal(
    chatSocketUrl({ protocol: 'http:', get host() { throw new Error('blocked') } }),
    '',
  )

  globalThis.location = { protocol: 'https:', host: 'anishare.local' }
  assert.equal(chatSocketUrl(), 'wss://anishare.local/api/agent/chat')
})

test('parseServerFrame accepts the documented frame types and rejects malformed frames', () => {
  const valid = [
    { type: 'ready', agent: { type: 'chat', label: '媒体助手' }, aiEnabled: true, model: 'm', tools: [] },
    { type: 'start', id: 'a' },
    { type: 'delta', id: 'a', text: '你' },
    { type: 'tool', id: 'a', toolCallId: 't1', name: 'search_media', label: '查询媒体库', phase: 'start' },
    { type: 'done', id: 'a', text: '你好', turns: 1, toolCalls: 0 },
    { type: 'error', id: 'a', code: 'CHAT_FAILED', message: '失败' },
    { type: 'aborted', id: 'a' },
    { type: 'pong' },
  ]
  for (const frame of valid) {
    assert.deepEqual(parseServerFrame(JSON.stringify(frame)), frame)
  }
  for (const raw of ['', 'not json', 'null', '[]', '42', '"ready"', '{}', '{"type":123}', '{"type":"unknown"}']) {
    assert.equal(parseServerFrame(raw), null, raw)
  }
  assert.equal(parseServerFrame(null), null)
  assert.equal(parseServerFrame({ type: 'pong' }), null)
})

test('loadConversation trims oversized stored conversations without dropping recent turns', () => {
  const stored = []
  for (let index = 0; index < 60; index += 1) {
    stored.push(msg('user', `问 ${index}`))
    stored.push(msg('assistant', `答 ${index}`))
  }
  storage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ version: 1, updatedAt: 123, messages: stored }))
  const loaded = loadConversation(storage)
  assert.equal(loaded.messages.length, MAX_MESSAGES)
  assert.equal(loaded.messages[0].content, '问 10')
  assert.equal(loaded.messages[loaded.messages.length - 1].content, '答 59')
  assert.equal(loaded.updatedAt, 123)
})
