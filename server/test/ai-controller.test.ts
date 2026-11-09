import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import Fastify from 'fastify'
import { randomBytes } from 'node:crypto'
import { createDatabase } from '../src/model/database.ts'
import { createAuthService } from '../src/service/auth.service.ts'
import { registerAuthController } from '../src/controller/auth.controller.ts'
import { createAiSettingsService } from '../src/service/ai-settings.service.ts'
import { createAgentService } from '../src/service/agent.service.ts'
import { registerAiController } from '../src/controller/ai.controller.ts'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-ai-controller-'))
after(() => fs.rm(temporary, { recursive: true, force: true }))
const apiKey = 'never-return-this-provider-api-key'
async function makeApp({ authSecret = 'access-key', runner, frontendOrigins = [] } = {}) {
  const app = Fastify({ logger: false })
  const database = createDatabase(':memory:')
  const settings = { authSecret, sessionDays: 30, secureCookies: false, frontendOrigins, dataDir: temporary,
    aiConfigKey: randomBytes(32).toString('base64'), aiDefaults: { enabled: false, apiFormat: 'openai-completions', baseUrl: '', model: '', apiKey: '', maxTokens: 2048, timeoutMs: 30000 } }
  const authService = createAuthService(database, settings)
  const aiSettingsService = createAiSettingsService(database, settings)
  const agentService = createAgentService(aiSettingsService, runner || (async () => ({ text: 'OK', model: 'example', usage: {}, stopReason: 'stop' })))
  app.addHook('onClose', async () => database.close())
  app.setErrorHandler((error, req, reply) => reply.code(error.status || error.statusCode || 500).send({ error: error.message, code: error.code }))
  registerAuthController(app, { authService, settings })
  registerAiController(app, { authService, settings, aiSettingsService, agentService })
  await app.ready()
  return app
}
async function cookieFor(app, headers) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { key: 'access-key' } })
  assert.equal(response.statusCode, 200)
  return response.headers['set-cookie'].split(';')[0]
}
const draft = { enabled: true, apiFormat: 'openai-completions', baseUrl: 'https://provider.example/v1', model: 'saved-model', apiKey }

test('AI config and agent require configured login, then authenticated cookies and same-origin mutations', async () => {
  const open = await makeApp({ authSecret: '' })
  try {
    for (const [method, url] of [['GET', '/api/admin/ai/config'], ['PUT', '/api/admin/ai/config'], ['POST', '/api/admin/ai/test'], ['POST', '/api/agent/run']]) {
      const response = await open.inject({ method, url })
      assert.equal(response.statusCode, 403)
      assert.equal(response.json().code, 'ADMIN_AUTH_REQUIRED')
    }
  } finally { await open.close() }
  const protectedApp = await makeApp()
  try {
    for (const [method, url] of [['GET', '/api/admin/ai/config'], ['PUT', '/api/admin/ai/config'], ['POST', '/api/admin/ai/test'], ['POST', '/api/agent/run']]) {
      assert.equal((await protectedApp.inject({ method, url })).statusCode, 401)
    }
    const cookie = await cookieFor(protectedApp)
    const csrf = await protectedApp.inject({ method: 'PUT', url: '/api/admin/ai/config', headers: { cookie, origin: 'https://untrusted.example' }, payload: draft })
    assert.equal(csrf.statusCode, 403)
    const config = await protectedApp.inject({ url: '/api/admin/ai/config', headers: { cookie } })
    assert.equal(config.statusCode, 200)
    assert.equal(config.headers['cache-control'], 'no-store')
    assert.equal(config.json().config.hasApiKey, false)
  } finally { await protectedApp.close() }
})

test('draft connection test does not save, saved run ignores no inline overrides, and secrets are never returned', async () => {
  const calls = []
  const app = await makeApp({ runner: async (config, input) => {
    calls.push({ config, input })
    return { text: 'OK', model: config.model, usage: { input: 2, output: 1 }, stopReason: 'stop' }
  } })
  try {
    const cookie = await cookieFor(app)
    const headers = { cookie }
    const disabled = await app.inject({ method: 'POST', url: '/api/agent/run', headers, payload: { prompt: 'hello' } })
    assert.equal(disabled.statusCode, 409)
    assert.equal(disabled.json().code, 'AI_DISABLED')
    const tested = await app.inject({ method: 'POST', url: '/api/admin/ai/test', headers, payload: { ...draft, enabled: false } })
    assert.equal(tested.statusCode, 200)
    assert.equal(tested.json().reply, 'OK')
    assert.equal(calls[0].config.maxTokens, 32)
    assert.equal(calls[0].config.apiKey, apiKey)
    assert.equal(calls[0].input.prompt, '只回复 OK。')
    assert.ok(calls[0].input.signal instanceof AbortSignal)
    assert.equal((await app.inject({ url: '/api/admin/ai/config', headers })).json().config.model, '')
    const saved = await app.inject({ method: 'PUT', url: '/api/admin/ai/config', headers, payload: draft })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().config.hasApiKey, true)
    assert.ok(!saved.body.includes(apiKey))
    const run = await app.inject({ method: 'POST', url: '/api/agent/run', headers, payload: { prompt: ' hello ' } })
    assert.equal(run.statusCode, 200)
    assert.equal(calls[1].config.model, 'saved-model')
    assert.equal(calls[1].config.apiKey, apiKey)
    assert.equal(calls[1].input.prompt, 'hello')
    assert.ok(!run.body.includes(apiKey))
    const override = await app.inject({ method: 'POST', url: '/api/agent/run', headers, payload: { prompt: 'hello', model: 'other-model' } })
    assert.equal(override.statusCode, 400)
    const cleared = await app.inject({ method: 'PUT', url: '/api/admin/ai/config', headers, payload: { clearApiKey: true } })
    assert.equal(cleared.json().config.hasApiKey, false)
  } finally { await app.close() }
})

test('upstream provider failures and timeouts never reflect provider secrets or disconnect the login session', async () => {
  let timeout = false
  const app = await makeApp({ runner: async () => { throw Object.assign(new Error(`upstream echoed ${apiKey}`), { status: timeout ? 504 : 401, code: 'AI_PROVIDER_ERROR' }) } })
  try {
    const cookie = await cookieFor(app)
    const headers = { cookie }
    await app.inject({ method: 'PUT', url: '/api/admin/ai/config', headers, payload: draft })
    const failed = await app.inject({ method: 'POST', url: '/api/agent/run', headers, payload: { prompt: 'hello' } })
    assert.equal(failed.statusCode, 502)
    assert.ok(!failed.body.includes(apiKey))
    timeout = true
    const timedOut = await app.inject({ method: 'POST', url: '/api/admin/ai/test', headers, payload: {} })
    assert.equal(timedOut.statusCode, 504)
    assert.equal(timedOut.json().code, 'AI_REQUEST_TIMEOUT')
    assert.ok(!timedOut.body.includes(apiKey))
    assert.equal((await app.inject({ url: '/api/auth/session', headers })).json().authenticated, true)
  } finally { await app.close() }
})

test('explicit frontend origins permit controller mutations while unlisted origins remain blocked', async () => {
  const app = await makeApp({ frontendOrigins: ['http://frontend.local:5173'] })
  try {
    const headers = { host: 'backend.local:8088', origin: 'http://frontend.local:5173', 'sec-fetch-site': 'cross-site' }
    const cookie = await cookieFor(app, headers)
    const saved = await app.inject({ method: 'PUT', url: '/api/admin/ai/config', headers: { ...headers, cookie }, payload: draft })
    assert.equal(saved.statusCode, 200)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/ai/config', headers: { ...headers, cookie, origin: 'http://other.local:5173' }, payload: draft })).statusCode, 403)
  } finally { await app.close() }
})

test('client disconnect after uploading the request body aborts the agent signal', async () => {
  let startedResolve
  let abortedResolve
  const started = new Promise((resolve) => { startedResolve = resolve })
  const aborted = new Promise((resolve) => { abortedResolve = resolve })
  const app = await makeApp({ runner: async (config, { signal }) => {
    startedResolve()
    return new Promise((resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error('Agent was not canceled')), 2000)
      signal.addEventListener('abort', () => {
        clearTimeout(fallback)
        abortedResolve(true)
        reject(Object.assign(new Error('Canceled'), { name: 'AbortError' }))
      }, { once: true })
    })
  } })
  let request
  try {
    const cookie = await cookieFor(app)
    await app.inject({ method: 'PUT', url: '/api/admin/ai/config', headers: { cookie }, payload: draft })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const body = JSON.stringify({ prompt: 'Wait for cancellation' })
    request = http.request({ host: '127.0.0.1', port: app.server.address().port, method: 'POST', path: '/api/agent/run',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } })
    request.on('error', () => {})
    request.end(body)
    await started
    request.destroy()
    let deadline
    const observed = await Promise.race([aborted, new Promise((resolve) => { deadline = setTimeout(() => resolve(false), 500) })])
    clearTimeout(deadline)
    assert.equal(observed, true)
  } finally {
    request?.destroy()
    await app.close()
  }
})
