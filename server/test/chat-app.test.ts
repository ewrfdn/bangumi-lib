import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'

// 与 scan-api.test.ts 相同：先准备临时环境，再在顶部 await 动态加载 app（config 在导入时读取环境变量）。
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-chat-app-'))
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.DATA_DIR = path.join(temporary, 'data')
process.env.BANGUMI_LIBRARY = path.join(temporary, 'library')
process.env.TASKS_CONFIG = path.join(temporary, 'tasks.yaml')
await fs.mkdir(path.join(temporary, 'library'), { recursive: true })
await fs.writeFile(path.join(temporary, 'tasks.yaml'), 'tasks: []\n')

const { createApp } = await import('../src/app.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))

const ACCESS_KEY = 'access-test-key'
const PROVIDER_KEY = 'never-leak-this-provider-key'
const CHAT_PATH = '/api/agent/chat'
/** 假 runner 收集的真实入参，用来断言 app.ts 装配后的 AgentManager 契约。 */
const runnerCalls = []

const fakeRunner = async (config, options) => {
  runnerCalls.push({ config, options })
  options.onEvent?.({ type: 'delta', text: '你好' })
  options.onEvent?.({ type: 'tool_start', toolCallId: 'call-1', name: 'search_media', args: { q: '魔法少女' } })
  options.onEvent?.({ type: 'tool_end', toolCallId: 'call-1', name: 'search_media', isError: false, durationMs: 5 })
  return { text: '你好，找到 2 部。', model: config.model, turns: 1, toolCalls: 1 }
}

async function makeApp() {
  const app = await createApp({
    dbPath: ':memory:', logger: false, authSecret: ACCESS_KEY, runPiAgentWithTools: fakeRunner,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  return { app, port: app.server.address().port }
}

async function login(app) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: ACCESS_KEY } })
  assert.equal(response.statusCode, 200, response.body)
  return response.headers['set-cookie'].split(';')[0]
}

async function enableAi(app, cookie) {
  const response = await app.inject({
    method: 'PUT', url: '/api/admin/ai/config', headers: { cookie },
    payload: {
      enabled: true, apiFormat: 'openai-completions', baseUrl: 'https://provider.example/v1',
      model: 'fake-chat-model', apiKey: PROVIDER_KEY,
    },
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.ok(!response.body.includes(PROVIDER_KEY))
}

function connect(port, cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${CHAT_PATH}`, { headers: { Cookie: cookie } })
  const frames = []
  const waiters = []
  let failure = null
  const closed = new Promise((resolve) => {
    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() })
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
    ws.once('error', reject)
  })
  const next = (timeoutMs = 4000) => new Promise((resolve, reject) => {
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
    ws, next, waitOpen, closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    terminate: () => { try { ws.terminate() } catch { /* ignored */ } },
  }
}

const toolNamesOf = (app) => app.services.agentManager.get('chat').tools({ messages: [] }).map((tool) => tool.name)

test('真实应用未启用模型时：ready 与 chat.tools 一致、aiEnabled=false，chat 返回 AI_DISABLED', async () => {
  const { app, port } = await makeApp()
  const cookie = await login(app)
  const client = connect(port, cookie)
  try {
    await client.waitOpen
    const ready = await client.next()
    assert.equal(ready.type, 'ready')
    assert.deepEqual(ready.agent, { type: 'chat', label: '媒体助手' })
    assert.equal(ready.aiEnabled, false)
    assert.equal(ready.model, null)
    assert.equal(ready.tools.length, 20)
    assert.deepEqual(ready.tools.map((tool) => tool.name), toolNamesOf(app))
    assert.ok(!JSON.stringify(ready).includes(PROVIDER_KEY))

    client.send({ type: 'chat', id: 'disabled-1', message: '在吗', history: [] })
    const start = await client.next()
    assert.deepEqual(start, { type: 'start', id: 'disabled-1' })
    const error = await client.next()
    assert.equal(error.type, 'error')
    assert.equal(error.id, 'disabled-1')
    assert.equal(error.code, 'AI_DISABLED')
    assert.match(error.message, /模型服务/)
    assert.equal(runnerCalls.length, 0)
  } finally {
    client.terminate()
    await app.close()
  }
})

test('真实应用装配：登录+配置模型后走完整 WS 对话，上下文透传、不落库，app.close 关闭连接', async () => {
  const { app, port } = await makeApp()
  const cookie = await login(app)
  await enableAi(app, cookie)
  const client = connect(port, cookie)
  let appClosed = false
  try {
    await client.waitOpen
    const ready = await client.next()
    assert.equal(ready.type, 'ready')
    assert.deepEqual(ready.agent, { type: 'chat', label: '媒体助手' })
    assert.equal(ready.aiEnabled, true)
    assert.equal(ready.model, 'fake-chat-model')
    assert.equal(ready.tools.length, 20)
    assert.deepEqual(ready.tools.map((tool) => tool.name), toolNamesOf(app))
    assert.ok(ready.tools.some((tool) => tool.name === 'search_media' && tool.label === '搜索本地影视'))
    assert.ok(!JSON.stringify(ready).includes(PROVIDER_KEY))

    // 对话前的数据库状态：app_settings 里只有 AI 配置，没有对话相关写入。
    const infoBefore = app.database.info()
    const aiConfigBefore = app.database.getSetting('ai-config')
    assert.deepEqual(Object.keys(app.database).filter((key) => /chat|conversation|message/i.test(key)), [])
    assert.equal((await app.inject({ url: CHAT_PATH })).statusCode, 401)
    assert.equal((await app.inject({ url: CHAT_PATH, headers: { cookie } })).statusCode, 404)

    runnerCalls.length = 0
    client.send({
      type: 'chat', id: 'chat-app-1', message: '最近看了什么？',
      history: [{ role: 'user', content: '先前的提问' }, { role: 'assistant', content: '先前的回答' }],
    })
    const frames = []
    for (let index = 0; index < 5; index += 1) frames.push(await client.next())
    assert.deepEqual(frames.map((frame) => frame.type), ['start', 'delta', 'tool', 'tool', 'done'])
    assert.equal(frames[0].id, 'chat-app-1')
    assert.deepEqual(frames[1], { type: 'delta', id: 'chat-app-1', text: '你好' })
    assert.deepEqual(frames[2], {
      type: 'tool', id: 'chat-app-1', toolCallId: 'call-1', name: 'search_media', label: '搜索本地影视', phase: 'start',
    })
    assert.deepEqual(frames[3], {
      type: 'tool', id: 'chat-app-1', toolCallId: 'call-1', name: 'search_media', label: '搜索本地影视',
      phase: 'end', ok: true, durationMs: 5,
    })
    assert.deepEqual(frames[4], { type: 'done', id: 'chat-app-1', text: '你好，找到 2 部。', turns: 1, toolCalls: 1 })

    // 假 runner 收到的就是装配后的 ChatAgent 定义 + 已保存的模型配置 + 客户端历史。
    assert.equal(runnerCalls.length, 1)
    const { config, options } = runnerCalls[0]
    assert.equal(config.model, 'fake-chat-model')
    assert.equal(config.apiKey, PROVIDER_KEY)
    assert.match(options.systemPrompt, /AniShare 个人媒体库的助手/)
    assert.equal(options.prompt, '最近看了什么？')
    assert.deepEqual(options.history, [{ role: 'user', content: '先前的提问' }, { role: 'assistant', content: '先前的回答' }])
    assert.equal(options.tools.length, 20)
    assert.deepEqual(options.tools.map((tool) => tool.name).sort(), [...toolNamesOf(app)].sort())
    assert.equal(options.maxTurns, 10)
    assert.equal(options.maxToolCalls, 32)
    assert.equal(options.timeoutMs, 120_000)
    assert.ok(options.signal instanceof AbortSignal)

    // 对话不落库：数据库摘要与 AI 配置都保持不变，没有对话相关接口/设置。
    assert.deepEqual(app.database.info(), infoBefore)
    assert.deepEqual(app.database.getSetting('ai-config'), aiConfigBefore)
    assert.equal(app.database.getSetting('agent-chat'), null)
    assert.equal(app.database.getSetting('chat-conversation'), null)
    assert.doesNotMatch(JSON.stringify(app.database.getSetting('ai-config')), new RegExp(PROVIDER_KEY))

    // 关闭真实应用应主动断开 WS 连接，且不会挂起。
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('app.close 未在时限内完成')), 5000)
    })
    await Promise.race([app.close(), timeout])
    clearTimeout(timer)
    appClosed = true
    const info = await client.closed
    assert.ok([1000, 1001, 1006].includes(info.code), `unexpected close code ${info.code}`)
  } finally {
    client.terminate()
    if (!appClosed) await app.close().catch(() => {})
  }
})
