import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import Fastify from 'fastify'
import { WebSocket } from 'ws'
import { createDatabase } from '../src/model/database.ts'
import { createAuthService } from '../src/service/auth.service.ts'
import { registerAuthController } from '../src/controller/auth.controller.ts'
import { AgentManager } from '../src/agent/AgentManager.ts'
import { createChatService } from '../src/service/chat.service.ts'
import { registerAgentChatController } from '../src/controller/agent-chat.controller.ts'

const API_KEY = 'never-leak-this-provider-key'
const ACCESS_KEY = 'access-test-key'
const CHAT_PATH = '/api/agent/chat'

/** 与后端 ChatAgent 同形的测试替身：定义层只负责 prompt/tools，运行交给注入的 runner。 */
const fakeTools = [
  {
    name: 'list_libraries', label: '媒体库列表', description: '列出所有媒体库及统计',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: '[]' }] }),
  },
  {
    name: 'search_media', label: '搜索影视', description: '按标题搜索本地影视',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: async () => ({ content: [{ type: 'text', text: '[]' }] }),
  },
]
const fakeChatAgent = {
  type: 'chat',
  label: '媒体助手',
  maxTurns: 10,
  maxToolCalls: 32,
  timeoutMs: 120_000,
  systemPrompt: () => '你是个人媒体库助手，只能依据工具结果回答。',
  userPrompt: (context) => context.messages[context.messages.length - 1].content,
  history: (context) => context.messages.slice(0, -1).map(({ role, content }) => ({ role, content })),
  tools: () => fakeTools,
  describe: () => ({ type: 'chat', label: '媒体助手' }),
}

const effectiveConfig = (enabled) => {
  if (!enabled) {
    throw Object.assign(new Error('AI Agent 尚未启用，请先在后台管理「模型服务」中开启'), { status: 409, code: 'AI_DISABLED' })
  }
  return {
    enabled: true, apiFormat: 'openai-completions', baseUrl: 'https://provider.example/v1',
    model: 'fake-chat-model', apiKey: API_KEY, maxTokens: 2048, timeoutMs: 30000,
  }
}

/** 只装配 WS 网关需要的部分：Fastify + 真实鉴权/数据库 + 假 aiSettings + 真实 AgentManager。 */
async function makeApp({ authSecret = ACCESS_KEY, frontendOrigins = [], aiEnabled = true, runner, chatAgent = fakeChatAgent } = {}) {
  const app = Fastify({ logger: false })
  const database = createDatabase(':memory:')
  const settings = { authSecret, sessionDays: 30, secureCookies: false, frontendOrigins }
  const authService = createAuthService(database, settings)
  const aiSettings = {
    publicConfig: () => ({
      enabled: aiEnabled, apiFormat: 'openai-completions', baseUrl: aiEnabled ? 'https://provider.example/v1' : '',
      model: aiEnabled ? 'fake-chat-model' : '', maxTokens: 2048, timeoutMs: 30000,
      hasApiKey: aiEnabled, apiKeySource: aiEnabled ? 'stored' : 'none',
    }),
    effective: () => effectiveConfig(aiEnabled),
  }
  const calls = []
  const agents = new AgentManager({
    resolveConfig: () => aiSettings.effective(),
    runner: async (config, options) => {
      calls.push({ config, options })
      if (runner) return runner(config, options)
      return { text: '默认回复', model: config.model, turns: 1, toolCalls: 0 }
    },
  })
  agents.register(chatAgent)
  const chatService = createChatService({ agents, aiSettings })
  app.addHook('onClose', async () => database.close())
  registerAuthController(app, { authService, settings })
  registerAgentChatController(app, { chatService, authService, settings, logger: app.log })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address()
  return { app, database, authService, chatService, settings, calls, port }
}

async function loginCookie(app) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: ACCESS_KEY } })
  assert.equal(response.statusCode, 200, response.body)
  return response.headers['set-cookie'].split(';')[0]
}

/** 直接发一个 Upgrade 请求，返回服务端握手响应（101 或拒绝状态码 + JSON body）。 */
function requestUpgrade(port, { path = CHAT_PATH, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers,
      },
    })
    request.setTimeout(4000, () => request.destroy(new Error('upgrade timeout')))
    request.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve({ status: response.statusCode, headers: response.headers, body: '' })
    })
    request.on('response', (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

/** 极简 WS 帧客户端：缓存帧、按需等待，误帧/超时给出可读错误。 */
function connect(port, { cookie, headers = {} } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${CHAT_PATH}`, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
  })
  const frames = []
  const waiters = []
  let failure = null
  let closedInfo = null
  const closed = new Promise((resolve) => {
    ws.on('close', (code, reason) => {
      closedInfo = { code, reason: reason.toString() }
      resolve(closedInfo)
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`connection closed (${code})`))
    })
  })
  ws.on('error', (error) => { failure = error })
  ws.on('message', (data) => {
    let frame
    try { frame = JSON.parse(data.toString()) } catch { frame = { type: 'invalid-json', raw: data.toString() } }
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(frame)
    else frames.push(frame)
  })
  const waitOpen = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', (error) => reject(error))
  })
  const next = (timeoutMs = 3000) => new Promise((resolve, reject) => {
    const buffered = frames.shift()
    if (buffered) { resolve(buffered); return }
    const entry = { resolve, reject }
    const timer = setTimeout(() => {
      const index = waiters.indexOf(entry)
      if (index >= 0) waiters.splice(index, 1)
      reject(new Error(`timed out waiting for frame (last error: ${failure?.message || 'none'})`))
    }, timeoutMs)
    entry.resolve = (frame) => { clearTimeout(timer); resolve(frame) }
    entry.reject = (error) => { clearTimeout(timer); reject(error) }
    waiters.push(entry)
  })
  return {
    ws, frames, next, waitOpen, closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    sendRaw: (raw) => ws.send(raw),
    close: () => { try { ws.close() } catch { /* ignored */ } },
    terminate: () => { try { ws.terminate() } catch { /* ignored */ } },
    get closedInfo() { return closedInfo },
  }
}

async function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const rejectionOf = async (promise) => {
  let failure
  try { await promise } catch (error) { failure = error }
  assert.ok(failure, 'expected the promise to reject')
  return failure
}

test('握手鉴权：未配置 AUTH_SECRET 返回 403、未登录或伪造 Cookie 返回 401', async () => {
  const open = await makeApp({ authSecret: '' })
  try {
    const response = await requestUpgrade(open.port)
    assert.equal(response.status, 403)
    assert.deepEqual(JSON.parse(response.body), {
      error: '请先配置 AUTH_SECRET，登录后才能使用 AI 助手',
      code: 'ADMIN_AUTH_REQUIRED',
    })
  } finally { await open.app.close() }

  const app = await makeApp()
  try {
    const anonymous = await requestUpgrade(app.port)
    assert.equal(anonymous.status, 401)
    assert.equal(JSON.parse(anonymous.body).code, 'UNAUTHORIZED')
    for (const cookie of [`anishare_session=${'a'.repeat(64)}`, 'anishare_session=short', 'other=value']) {
      const response = await requestUpgrade(app.port, { headers: { Cookie: cookie } })
      assert.equal(response.status, 401, cookie)
      assert.equal(JSON.parse(response.body).code, 'UNAUTHORIZED')
    }
  } finally { await app.app.close() }
})

test('握手只接受 /api/agent/chat，并校验 Origin 同源或白名单', async () => {
  const app = await makeApp({ frontendOrigins: ['http://frontend.local:5173'] })
  const cookie = await loginCookie(app.app)
  try {
    const wrongPath = await requestUpgrade(app.port, { path: '/api/other', headers: { Cookie: cookie } })
    assert.equal(wrongPath.status, 404)
    assert.deepEqual(JSON.parse(wrongPath.body), { error: '接口不存在' })
    const crossSite = await requestUpgrade(app.port, { headers: { Cookie: cookie, Origin: 'https://evil.example' } })
    assert.equal(crossSite.status, 403)
    assert.deepEqual(JSON.parse(crossSite.body), { error: '不允许跨站请求' })
    const sameOrigin = await requestUpgrade(app.port, { headers: { Cookie: cookie, Origin: `http://127.0.0.1:${app.port}` } })
    assert.equal(sameOrigin.status, 101)
    const whitelisted = await requestUpgrade(app.port, {
      headers: { Cookie: cookie, Host: 'backend.local:8088', Origin: 'http://frontend.local:5173' },
    })
    assert.equal(whitelisted.status, 101)
    const unlistedOriginBehindProxy = await requestUpgrade(app.port, {
      headers: { Cookie: cookie, Host: 'backend.local:8088', Origin: 'http://other.local:5173' },
    })
    assert.equal(unlistedOriginBehindProxy.status, 403)
  } finally { await app.app.close() }
})

test('登录后握手收到 ready，chat 流式返回 start/delta/tool/done 并按契约透传上下文', async () => {
  const optionsSeen = []
  const app = await makeApp({ runner: async (config, options) => {
    assert.equal(config.model, 'fake-chat-model')
    assert.equal(config.apiKey, API_KEY)
    optionsSeen.push(options)
    options.onEvent({ type: 'delta', text: '你好' })
    options.onEvent({ type: 'tool_start', toolCallId: 'call-1', name: 'search_media', args: { q: '魔法少女' } })
    options.onEvent({ type: 'tool_end', toolCallId: 'call-1', name: 'search_media', isError: false, durationMs: 7 })
    options.onEvent({ type: 'delta', text: '，找到 2 部。' })
    return { text: '你好，找到 2 部。', model: config.model, turns: 2, toolCalls: 1 }
  } })
  const cookie = await loginCookie(app.app)
  const client = connect(app.port, { cookie })
  try {
    await client.waitOpen
    const ready = await client.next()
    assert.equal(ready.type, 'ready')
    assert.deepEqual(ready.agent, { type: 'chat', label: '媒体助手' })
    assert.equal(ready.aiEnabled, true)
    assert.equal(ready.model, 'fake-chat-model')
    assert.deepEqual(ready.tools.map((tool) => tool.name), ['list_libraries', 'search_media'])
    assert.ok(ready.tools.every((tool) => tool.label && tool.description))
    assert.ok(!JSON.stringify(ready).includes(API_KEY))

    client.send({
      type: 'chat', id: 'req-1', message: ' 你好 ',
      history: [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回答' }],
    })
    const frames = []
    for (let index = 0; index < 6; index += 1) frames.push(await client.next())
    assert.deepEqual(frames.map((frame) => frame.type), ['start', 'delta', 'tool', 'tool', 'delta', 'done'])
    assert.equal(frames[0].id, 'req-1')
    assert.deepEqual(frames[1], { type: 'delta', id: 'req-1', text: '你好' })
    assert.deepEqual(frames[2], {
      type: 'tool', id: 'req-1', toolCallId: 'call-1', name: 'search_media', label: '搜索影视', phase: 'start',
    })
    assert.deepEqual(frames[3], {
      type: 'tool', id: 'req-1', toolCallId: 'call-1', name: 'search_media', label: '搜索影视', phase: 'end', ok: true, durationMs: 7,
    })
    assert.deepEqual(frames[5], { type: 'done', id: 'req-1', text: '你好，找到 2 部。', turns: 2, toolCalls: 1 })

    assert.equal(optionsSeen.length, 1)
    const options = optionsSeen[0]
    assert.equal(options.prompt, '你好')
    assert.match(options.systemPrompt, /媒体库助手/)
    assert.deepEqual(options.history, [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回答' }])
    assert.equal(options.tools.length, 2)
    assert.equal(options.maxTurns, 10)
    assert.equal(options.maxToolCalls, 32)
    assert.equal(options.timeoutMs, 120_000)
    assert.ok(options.signal instanceof AbortSignal)
  } finally {
    client.close()
    await app.app.close()
  }
})

test('同一连接同时只允许一轮：重入返回 CHAT_BUSY，前一轮仍正常 done', async () => {
  let finishFirst
  const app = await makeApp({ runner: async (config, options) => {
    options.onEvent({ type: 'delta', text: '处理中' })
    return new Promise((resolve) => {
      finishFirst = () => resolve({ text: '第一轮完成', model: config.model, turns: 1, toolCalls: 0 })
    })
  } })
  const cookie = await loginCookie(app.app)
  const client = connect(app.port, { cookie })
  try {
    await client.waitOpen
    await client.next()
    client.send({ type: 'chat', id: 'first', message: '第一轮', history: [] })
    assert.equal((await client.next()).type, 'start')
    assert.equal((await client.next()).type, 'delta')
    client.send({ type: 'chat', id: 'second', message: '第二轮', history: [] })
    const busy = await client.next()
    assert.deepEqual(busy, {
      type: 'error', id: 'second', code: 'CHAT_BUSY', message: '上一轮对话仍在进行中，请稍候。',
    })
    await waitFor(() => typeof finishFirst === 'function', { label: 'runner start' })
    finishFirst()
    const done = await client.next()
    assert.equal(done.type, 'done')
    assert.equal(done.id, 'first')
    assert.equal(done.text, '第一轮完成')
  } finally {
    client.close()
    await app.app.close()
  }
})

test('abort 中止进行中的 Agent 并返回 aborted，连接随后仍可用', async () => {
  let signalSeen
  const app = await makeApp({ runner: async (config, options) => {
    signalSeen = options.signal
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runner was not aborted')), 3000)
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('模型请求已取消。'), { code: 'PI_ABORTED', statusCode: 499 }))
      }, { once: true })
    })
  } })
  const cookie = await loginCookie(app.app)
  const client = connect(app.port, { cookie })
  try {
    await client.waitOpen
    await client.next()
    client.send({ type: 'chat', id: 'cancel-me', message: '等一下', history: [] })
    assert.equal((await client.next()).type, 'start')
    await waitFor(() => signalSeen !== undefined, { label: 'runner start' })
    client.send({ type: 'abort', id: 'cancel-me' })
    const aborted = await client.next()
    assert.deepEqual(aborted, { type: 'aborted', id: 'cancel-me' })
    assert.equal(signalSeen.aborted, true)
    client.send({ type: 'ping' })
    assert.deepEqual(await client.next(), { type: 'pong' })
  } finally {
    client.close()
    await app.app.close()
  }
})

test('非法帧返回安全错误码：坏 JSON、未知 type、坏 id、空/超长消息、非法 history', async () => {
  const app = await makeApp()
  const cookie = await loginCookie(app.app)
  const client = connect(app.port, { cookie })
  try {
    await client.waitOpen
    await client.next()

    client.sendRaw('not-json')
    let frame = await client.next()
    assert.equal(frame.type, 'error')
    assert.equal(frame.code, 'CHAT_INVALID')
    assert.equal(frame.id, undefined)

    client.send({ type: 'unknown' })
    frame = await client.next()
    assert.equal(frame.type, 'error')
    assert.equal(frame.code, 'CHAT_INVALID')

    client.send({ type: 'chat', id: 'bad id!', message: 'hi', history: [] })
    frame = await client.next()
    assert.equal(frame.code, 'CHAT_INVALID')
    assert.equal(frame.id, undefined)

    client.send({ type: 'chat', id: 'm-1', message: '   ', history: [] })
    frame = await client.next()
    assert.deepEqual(frame, { type: 'error', id: 'm-1', code: 'CHAT_INVALID', message: '消息内容不能为空。' })

    client.send({ type: 'chat', id: 'm-2', message: 'x'.repeat(8001), history: [] })
    frame = await client.next()
    assert.equal(frame.code, 'CHAT_INVALID')
    assert.equal(frame.id, 'm-2')

    client.send({ type: 'chat', id: 'h-1', message: 'hi', history: 'bad' })
    frame = await client.next()
    assert.equal(frame.type, 'error')
    assert.equal(frame.id, 'h-1')
    assert.equal(frame.code, 'CHAT_HISTORY_INVALID')

    client.send({ type: 'chat', id: 'h-2', message: 'hi', history: [{ role: 'system', content: 'x' }] })
    frame = await client.next()
    assert.equal(frame.code, 'CHAT_HISTORY_INVALID')

    client.send({ type: 'chat', id: 'h-3', message: 'hi', history: [{ role: 'user', content: '' }] })
    frame = await client.next()
    assert.equal(frame.code, 'CHAT_HISTORY_INVALID')

    const tooManyTurns = Array.from({ length: 41 }, (_value, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant', content: 'x',
    }))
    client.send({ type: 'chat', id: 'h-4', message: 'hi', history: tooManyTurns })
    frame = await client.next()
    assert.equal(frame.code, 'CHAT_HISTORY_INVALID')

    client.send({ type: 'ping' })
    assert.deepEqual(await client.next(), { type: 'pong' })
  } finally {
    client.close()
    await app.app.close()
  }
})

test('超过 maxPayload 的帧会被断开连接', async () => {
  const app = await makeApp()
  const cookie = await loginCookie(app.app)
  const client = connect(app.port, { cookie })
  try {
    await client.waitOpen
    await client.next()
    client.send({ type: 'ping', pad: 'x'.repeat(300 * 1024) })
    const info = await client.closed
    assert.equal(info.code, 1009)
  } finally {
    client.terminate()
    await app.app.close()
  }
})

test('客户端断开连接会中止进行中的 Agent 信号', async () => {
  let signalSeen
  const app = await makeApp({ runner: async (config, options) => {
    signalSeen = options.signal
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runner was not aborted')), 3000)
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('模型请求已取消。'), { code: 'PI_ABORTED', statusCode: 499 }))
      }, { once: true })
    })
  } })
  const cookie = await loginCookie(app.app)
  const client = connect(app.port, { cookie })
  try {
    await client.waitOpen
    await client.next()
    client.send({ type: 'chat', id: 'drop-me', message: '等一下', history: [] })
    assert.equal((await client.next()).type, 'start')
    await waitFor(() => signalSeen !== undefined, { label: 'runner start' })
    client.terminate()
    await client.closed
    await waitFor(() => signalSeen.aborted, { label: 'agent signal abort' })
    assert.equal(signalSeen.aborted, true)
  } finally {
    client.terminate()
    await app.app.close()
  }
})

test('模型未启用时 ready.aiEnabled=false，chat 返回 AI_DISABLED 中文提示且不泄露密钥', async () => {
  const app = await makeApp({ aiEnabled: false })
  const cookie = await loginCookie(app.app)
  const client = connect(app.port, { cookie })
  try {
    await client.waitOpen
    const ready = await client.next()
    assert.equal(ready.type, 'ready')
    assert.equal(ready.aiEnabled, false)
    assert.equal(ready.model, null)
    assert.equal(ready.tools.length, fakeTools.length)
    client.send({ type: 'chat', id: 'disabled-1', message: '在吗', history: [] })
    assert.equal((await client.next()).type, 'start')
    const error = await client.next()
    assert.equal(error.type, 'error')
    assert.equal(error.id, 'disabled-1')
    assert.equal(error.code, 'AI_DISABLED')
    assert.match(error.message, /模型服务/)
    assert.ok(!JSON.stringify(error).includes(API_KEY))
    assert.equal(app.calls.length, 0)
  } finally {
    client.close()
    await app.app.close()
  }
})

test('运行异常转译为安全错误帧：PI_TIMEOUT 固定文案、未知错误统一 CHAT_FAILED', async () => {
  let failure = { code: 'PI_TIMEOUT', message: '模型请求超时，请稍后重试。' }
  const app = await makeApp({ runner: async () => { throw Object.assign(new Error(failure.message), { status: 504, code: failure.code }) } })
  const cookie = await loginCookie(app.app)
  const client = connect(app.port, { cookie })
  try {
    await client.waitOpen
    await client.next()
    client.send({ type: 'chat', id: 'e-1', message: '一', history: [] })
    await client.next()
    let frame = await client.next()
    assert.deepEqual(frame, {
      type: 'error', id: 'e-1', code: 'PI_TIMEOUT', message: '模型响应超时，请稍后重试。',
    })

    failure = { code: 'INTERNAL_SQL_ERROR', message: `upstream echoed ${API_KEY}` }
    client.send({ type: 'chat', id: 'e-2', message: '二', history: [] })
    await client.next()
    frame = await client.next()
    assert.deepEqual(frame, {
      type: 'error', id: 'e-2', code: 'CHAT_FAILED', message: '助手暂时无法回复，请稍后重试。',
    })
    assert.ok(!JSON.stringify(frame).includes(API_KEY))

    failure = { code: 'AI_CONFIG_DECRYPTION_FAILED', message: 'AI 配置解密失败，请检查 AI_CONFIG_KEY 或数据目录中的 ai-config.key' }
    client.send({ type: 'chat', id: 'e-3', message: '三', history: [] })
    await client.next()
    frame = await client.next()
    assert.equal(frame.code, 'AI_CONFIG_DECRYPTION_FAILED')
    assert.equal(frame.message, 'AI 配置解密失败，请检查 AI_CONFIG_KEY 或数据目录中的 ai-config.key')
  } finally {
    client.close()
    await app.app.close()
  }
})

test('app.close 会关闭 WebSocket 连接且不会挂起', async () => {
  const app = await makeApp()
  const cookie = await loginCookie(app.app)
  const client = connect(app.port, { cookie })
  try {
    await client.waitOpen
    await client.next()
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('app.close 未在时限内完成')), 4000)
    })
    await Promise.race([app.app.close(), timeout])
    clearTimeout(timer)
    const info = await client.closed
    assert.ok([1000, 1001, 1006].includes(info.code), `unexpected close code ${info.code}`)
  } finally {
    client.terminate()
    await app.app.close().catch(() => {})
  }
})

test('chat.service 校验输入并宽松归一历史，ready() 只暴露安全摘要', async () => {
  const calls = []
  const agents = {
    get(type) {
      assert.equal(type, 'chat')
      return fakeChatAgent
    },
    async run(type, context, options) {
      calls.push({ type, context, options })
      return { text: 'ok', model: 'fake-chat-model', turns: 1, toolCalls: 0 }
    },
  }
  const service = createChatService({
    agents,
    aiSettings: { publicConfig: () => ({ enabled: true, model: 'fake-chat-model', apiKey: API_KEY }) },
  })

  const ready = service.ready()
  assert.equal(ready.aiEnabled, true)
  assert.equal(ready.model, 'fake-chat-model')
  assert.deepEqual(ready.tools.map((tool) => tool.name), ['list_libraries', 'search_media'])
  assert.ok(!JSON.stringify(ready).includes(API_KEY))
  assert.deepEqual(Object.keys(ready.tools[0]).sort(), ['description', 'label', 'name'])

  const result = await service.chat({ messages: [{ role: 'user', content: '你好' }] })
  assert.equal(result.text, 'ok')
  assert.deepEqual(calls[0].context, { messages: [{ role: 'user', content: '你好' }] })
  assert.equal(calls[0].type, 'chat')

  // 连续同角色保留靠近当前的一条、去掉开头 assistant、去掉末尾未回复的 user。
  await service.chat({
    messages: [
      { role: 'assistant', content: '开场白' },
      { role: 'user', content: '旧问题' },
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '最新问题' },
    ],
  })
  assert.deepEqual(calls[1].context.messages, [
    { role: 'user', content: '新问题' },
    { role: 'assistant', content: '旧回答' },
    { role: 'user', content: '最新问题' },
  ])

  const invalidCases = [
    { label: 'not array', messages: 'bad', code: 'CHAT_INVALID' },
    { label: 'empty', messages: [], code: 'CHAT_INVALID' },
    { label: 'too many', messages: Array.from({ length: 42 }, () => ({ role: 'user', content: 'x' })), code: 'CHAT_INVALID' },
    { label: 'latest assistant', messages: [{ role: 'assistant', content: 'x' }], code: 'CHAT_INVALID' },
    { label: 'latest empty', messages: [{ role: 'user', content: '   ' }], code: 'CHAT_INVALID' },
    { label: 'latest too long', messages: [{ role: 'user', content: 'x'.repeat(8001) }], code: 'CHAT_INVALID' },
    { label: 'history role', messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'x' }], code: 'CHAT_HISTORY_INVALID' },
    { label: 'history empty', messages: [{ role: 'user', content: '' }, { role: 'user', content: 'x' }], code: 'CHAT_HISTORY_INVALID' },
    {
      label: 'history too long', code: 'CHAT_HISTORY_INVALID',
      messages: [
        ...Array.from({ length: 40 }, (_value, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(2000),
        })),
        { role: 'user', content: '最新' },
      ],
    },
  ]
  for (const entry of invalidCases) {
    const error = await rejectionOf(service.chat({ messages: entry.messages }))
    assert.equal(error.code, entry.code, entry.label)
    assert.equal(error.status, 400, entry.label)
    assert.ok(error.message.length > 0 && error.message.length < 100, entry.label)
  }

  // 失败请求不会触达 AgentManager。
  assert.equal(calls.length, 2)
})
