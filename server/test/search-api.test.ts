import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { randomBytes } from 'node:crypto'
import { createDatabase } from '../src/model/database.ts'
import { createAuthService } from '../src/service/auth.service.ts'
import { registerAuthController } from '../src/controller/auth.controller.ts'
import { createAiSettingsService } from '../src/service/ai-settings.service.ts'
import { createSearchSettingsService } from '../src/service/search-settings.service.ts'
import { createDeepSeekSearchService } from '../src/service/deepseek-search.service.ts'
import { registerAiController } from '../src/controller/ai.controller.ts'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-search-api-'))
after(() => fs.rm(temporary, { recursive: true, force: true }))
const apiKey = 'deepseek-search-api-key-never-return-this'

const SEARCH_PAYLOAD = { results: [{ rerank_score: 2.3, title: '示例', url: 'https://example.com/a', snippet: 's', summary: 'm', content: '', site_name: 'Example', date: null, authority: 3 }] }

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

async function makeApp({ authSecret = 'access-key', searchFetch, frontendOrigins = [] } = {}) {
  const app = Fastify({ logger: false })
  const database = createDatabase(':memory:')
  const settings = {
    authSecret, sessionDays: 30, secureCookies: false, frontendOrigins, dataDir: temporary,
    aiConfigKey: randomBytes(32).toString('base64'), deepseekSearchKey: '',
    aiDefaults: { enabled: false, apiFormat: 'openai-completions', baseUrl: '', model: '', apiKey: '', maxTokens: 2048, timeoutMs: 30000 },
    searchDefaults: { enabled: false, baseUrl: 'https://api.deepseek.com', count: 8, needContent: true, timeoutMs: 15000, reuseModelKey: false },
  }
  const authService = createAuthService(database, settings)
  const aiSettingsService = createAiSettingsService(database, settings)
  const searchSettingsService = createSearchSettingsService({ database, settings, aiSettings: aiSettingsService })
  const fetchCalls = []
  const searchService = createDeepSeekSearchService({
    settings: searchSettingsService,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init })
      return (searchFetch || (() => jsonResponse(SEARCH_PAYLOAD)))(String(url), init)
    },
  })
  const agentService = {
    async test() { return { ok: true, model: 'stub', apiFormat: 'openai-completions', latencyMs: 1, reply: 'OK' } },
    async run() { return { text: 'OK', model: 'stub' } },
  }
  app.addHook('onClose', async () => database.close())
  app.setErrorHandler((error, _req, reply) => reply.code(error.status || error.statusCode || 500).send({ error: error.message, code: error.code }))
  registerAuthController(app, { authService, settings })
  registerAiController(app, { authService, aiSettingsService, agentService, searchSettingsService, searchService })
  await app.ready()
  return { app, database, fetchCalls, searchSettingsService }
}

async function cookieFor(app, headers) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { key: 'access-key' } })
  assert.equal(response.statusCode, 200)
  return response.headers['set-cookie'].split(';')[0]
}

const draft = {
  enabled: true, baseUrl: 'https://api.deepseek.com', count: 5,
  needContent: false, timeoutMs: 5000, reuseModelKey: false, apiKey,
}

test('search config endpoints require login and same-origin mutations', async () => {
  const open = await makeApp({ authSecret: '' })
  try {
    for (const [method, url] of [['GET', '/api/admin/ai/search'], ['PUT', '/api/admin/ai/search'], ['POST', '/api/admin/ai/search/test']]) {
      const response = await open.app.inject({ method, url })
      assert.equal(response.statusCode, 403)
      assert.equal(response.json().code, 'ADMIN_AUTH_REQUIRED')
    }
  } finally { await open.app.close() }

  const guarded = await makeApp()
  try {
    for (const [method, url] of [['GET', '/api/admin/ai/search'], ['PUT', '/api/admin/ai/search'], ['POST', '/api/admin/ai/search/test']]) {
      assert.equal((await guarded.app.inject({ method, url })).statusCode, 401)
    }
    const cookie = await cookieFor(guarded.app)
    const csrf = await guarded.app.inject({ method: 'PUT', url: '/api/admin/ai/search', headers: { cookie, origin: 'https://untrusted.example' }, payload: draft })
    assert.equal(csrf.statusCode, 403)
  } finally { await guarded.app.close() }
})

test('saving search config encrypts the DeepSeek key in its own app_settings row and never returns it', async () => {
  const { app, database } = await makeApp()
  try {
    const cookie = await cookieFor(app)
    const headers = { cookie }
    const initial = await app.inject({ url: '/api/admin/ai/search', headers })
    assert.equal(initial.statusCode, 200)
    assert.equal(initial.headers['cache-control'], 'no-store')
    const initialConfig = initial.json().config
    assert.equal(initialConfig.enabled, false)
    assert.equal(initialConfig.baseUrl, 'https://api.deepseek.com')
    assert.equal(initialConfig.hasApiKey, false)
    assert.equal(initialConfig.apiKeySource, 'none')

    const saved = await app.inject({ method: 'PUT', url: '/api/admin/ai/search', headers, payload: draft })
    assert.equal(saved.statusCode, 200)
    const savedConfig = saved.json().config
    assert.equal(savedConfig.enabled, true)
    assert.equal(savedConfig.hasApiKey, true)
    assert.equal(savedConfig.apiKeySource, 'stored')
    assert.equal(savedConfig.count, 5)
    assert.ok(!saved.body.includes(apiKey))
    assert.equal(database.getSetting('ai-config'), null)
    const row = database.getSetting('ai-search')
    assert.ok(row)
    assert.ok(!JSON.stringify(row).includes(apiKey))

    const reloaded = await app.inject({ url: '/api/admin/ai/search', headers })
    assert.equal(reloaded.json().config.hasApiKey, true)
    assert.ok(!reloaded.body.includes(apiKey))
  } finally { await app.close() }
})

test('invalid search config returns field errors instead of 500', async () => {
  const { app } = await makeApp()
  try {
    const cookie = await cookieFor(app)
    const cases = [
      [{ ...draft, count: 0 }, '返回条数'],
      [{ ...draft, timeoutMs: 999 }, 'timeoutMs'],
      [{ ...draft, baseUrl: 'ftp://api.deepseek.com' }, 'HTTP'],
      [{ ...draft, enabled: 'yes' }, 'enabled'],
      [{ ...draft, apiKey: apiKey + '\n' }, 'API Key'],
    ]
    for (const [payload, message] of cases) {
      const response = await app.inject({ method: 'PUT', url: '/api/admin/ai/search', headers: { cookie }, payload })
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().code, 'SEARCH_CONFIG_INVALID')
      assert.ok(String(response.json().error).includes(message))
      assert.ok(!response.body.includes(apiKey))
    }
  } finally { await app.close() }
})

test('search test endpoint calls the official DeepSeek endpoint with the saved key', async () => {
  const { app, fetchCalls } = await makeApp()
  try {
    const cookie = await cookieFor(app)
    const headers = { cookie }
    await app.inject({ method: 'PUT', url: '/api/admin/ai/search', headers, payload: draft })
    const tested = await app.inject({ method: 'POST', url: '/api/admin/ai/search/test', headers, payload: {} })
    assert.equal(tested.statusCode, 200)
    const body = tested.json()
    assert.equal(body.ok, true)
    assert.equal(body.provider, 'deepseek')
    assert.equal(body.count, 1)
    assert.deepEqual(body.sample, [{ title: '示例', url: 'https://example.com/a' }])
    assert.ok(body.latencyMs >= 0)
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, 'https://api.deepseek.com/v1/tools/search')
    assert.equal(fetchCalls[0].init.headers.Authorization, `Bearer ${apiKey}`)
    const sent = JSON.parse(fetchCalls[0].init.body)
    assert.equal(sent.count, 1)
    assert.equal(sent.need_content, false)
    assert.ok(!tested.body.includes(apiKey))
  } finally { await app.close() }
})

test('search test endpoint reports auth failures without echoing the key', async () => {
  const { app } = await makeApp({
    searchFetch: () => jsonResponse({ error: { message: 'invalid api key' } }, 401),
  })
  try {
    const cookie = await cookieFor(app)
    const headers = { cookie }
    await app.inject({ method: 'PUT', url: '/api/admin/ai/search', headers, payload: draft })
    const tested = await app.inject({ method: 'POST', url: '/api/admin/ai/search/test', headers, payload: {} })
    assert.equal(tested.statusCode, 400)
    assert.equal(tested.json().code, 'SEARCH_AUTH_FAILED')
    assert.ok(String(tested.json().error).includes('密钥'))
    assert.ok(!tested.body.includes(apiKey))
  } finally { await app.close() }
})

test('search test endpoint requires a key once the dedicated key is cleared', async () => {
  const { app } = await makeApp()
  try {
    const cookie = await cookieFor(app)
    const headers = { cookie }
    await app.inject({ method: 'PUT', url: '/api/admin/ai/search', headers, payload: draft })
    const cleared = await app.inject({ method: 'PUT', url: '/api/admin/ai/search', headers, payload: { clearApiKey: true } })
    assert.equal(cleared.json().config.hasApiKey, false)
    const tested = await app.inject({ method: 'POST', url: '/api/admin/ai/search/test', headers, payload: {} })
    assert.equal(tested.statusCode, 409)
    assert.equal(tested.json().code, 'SEARCH_NOT_CONFIGURED')
    assert.ok(String(tested.json().error).includes('API Key'))
  } finally { await app.close() }
})
