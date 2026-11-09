import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-transport-'))
await fs.mkdir(path.join(temporary, 'media'))
await fs.writeFile(path.join(temporary, 'media', 'episode.mp4'), '0123456789')
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.BANGUMI_ROOT = path.join(temporary, 'media')
process.env.DATA_DIR = path.join(temporary, 'data')
const { createApp } = await import('../src/app.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))
const application = (options = {}) => createApp({ logger: false, dbPath: ':memory:', authSecret: '', ...options })

test('backend is API-only even when the frontend build exists', async () => {
  const app = await application()
  try {
    for (const url of ['/', '/index.html', '/watch', '/admin']) {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 404)
      assert.match(response.headers['content-type'], /application\/json/)
      assert.deepEqual(response.json(), { error: '接口不存在' })
    }
    assert.equal((await app.inject('/api/auth/session')).statusCode, 200)
  } finally { await app.close() }
})

test('stream controller preserves suffix ranges, HEAD and invalid-range responses after layering', async () => {
  const app = await application()
  try {
    const suffix = await app.inject({ url: '/api/stream?path=/episode.mp4', headers: { range: 'bytes=-3' } })
    assert.equal(suffix.statusCode, 206)
    assert.equal(suffix.body, '789')
    assert.equal(suffix.headers['content-range'], 'bytes 7-9/10')
    const head = await app.inject({ method: 'HEAD', url: '/api/stream?path=/episode.mp4', headers: { range: 'bytes=2-5' } })
    assert.equal(head.statusCode, 206)
    assert.equal(head.headers['content-length'], '4')
    assert.equal(head.body, '')
    for (const range of ['bytes=-', 'bytes=20-', 'bytes=0-1,4-5']) {
      const response = await app.inject({ url: '/api/stream?path=/episode.mp4', headers: { range } })
      assert.equal(response.statusCode, 416)
      assert.equal(response.headers['content-range'], 'bytes */10')
    }
  } finally { await app.close() }
})

test('explicit frontend origins receive credentialed CORS without opening other origins', async () => {
  const app = await application({ frontendOrigins: ['http://localhost:5173'] })
  try {
    const response = await app.inject({
      method: 'OPTIONS', url: '/api/progress',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    })
    assert.equal(response.statusCode, 204)
    assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173')
    assert.equal(response.headers['access-control-allow-credentials'], 'true')
    const denied = await app.inject({ url: '/api/auth/session', headers: { origin: 'https://unlisted.example' } })
    assert.equal(denied.headers['access-control-allow-origin'], undefined)
  } finally { await app.close() }
})

test('HTTP controller through service, model and real Pi SDK uses saved config and keeps draft tests unsaved', async () => {
  const requests = []
  const upstream = http.createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push({ url: request.url, authorization: request.headers.authorization, body })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const base = { id: 'test-1', object: 'chat.completion.chunk', created: 1, model: body.model }
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const app = await application({ authSecret: 'access-test-key' })
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'access-test-key' } })
    const cookie = login.headers['set-cookie'].split(';')[0]
    const headers = { cookie }
    const saved = await app.inject({ method: 'PUT', url: '/api/admin/ai/config', headers, payload: {
      enabled: true, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'saved-model', apiKey: 'provider-test-secret',
    } })
    assert.equal(saved.statusCode, 200)
    assert.doesNotMatch(saved.body, /provider-test-secret/)
    const draft = await app.inject({ method: 'POST', url: '/api/admin/ai/test', headers, payload: { model: 'draft-model' } })
    assert.equal(draft.statusCode, 200, draft.body)
    assert.equal(draft.json().reply, 'OK')
    assert.equal(app.aiSettings.publicConfig().model, 'saved-model')
    const result = await app.inject({ method: 'POST', url: '/api/agent/run', headers, payload: { prompt: 'Respond with OK.' } })
    assert.equal(result.statusCode, 200, result.body)
    assert.equal(result.json().text, 'OK')
    assert.equal(result.json().model, 'saved-model')
    assert.deepEqual(requests.map((request) => request.body.model), ['draft-model', 'saved-model'])
    assert.ok(requests.every((request) => request.url === '/v1/chat/completions' && request.authorization === 'Bearer provider-test-secret'))
    assert.equal(requests[0].body.max_tokens, 32)
    assert.doesNotMatch(JSON.stringify(app.database.getSetting('ai-config')), /provider-test-secret/)
  } finally {
    await app.close()
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
  }
})
