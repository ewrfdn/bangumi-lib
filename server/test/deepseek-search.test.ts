import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createDatabase } from '../src/model/database.ts'
import { createSearchSettingsService } from '../src/service/search-settings.service.ts'
import { createDeepSeekSearchService } from '../src/service/deepseek-search.service.ts'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-deepseek-search-'))
after(() => fs.rm(temporary, { recursive: true, force: true }))

const database = createDatabase(':memory:')
after(() => database.close())

const settings = {
  dataDir: path.join(temporary, 'keys'),
  aiConfigKey: randomBytes(32).toString('base64'),
  deepseekSearchKey: '',
  searchDefaults: { enabled: false, baseUrl: 'https://api.deepseek.com', count: 8, needContent: true, timeoutMs: 15000, reuseModelKey: false },
}
const searchSettings = createSearchSettingsService({ database, settings, aiSettings: { apiKey: () => '' } })
searchSettings.save({
  enabled: true, baseUrl: 'https://api.deepseek.com', count: 5,
  needContent: true, timeoutMs: 5000, reuseModelKey: false, apiKey: 'deepseek-test-key',
})

const SEARCH_PAYLOAD = {
  results: [
    {
      rerank_score: 2.5, title: '示例条目', url: 'https://example.com/a', snippet: '摘要片段', summary: '较长的摘要内容',
      content: '<p>正文</p>', site_name: 'Example', site_icon: 'https://example.com/favicon.ico',
      date: '2026-01-02T03:04:05Z', authority: 3,
    },
    {
      rerank_score: 0.4, title: '第二条', url: 'https://example.com/b', snippet: 's2', summary: 'm2',
      content: '', site_name: null, site_icon: null, date: null, authority: -1,
    },
    { title: '无效链接', url: 'javascript:alert(1)', snippet: '', summary: '', content: '' },
  ],
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function recorder(handler = () => jsonResponse(SEARCH_PAYLOAD)) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return { calls, fetchImpl }
}

const serviceOf = (fetchImpl) => createDeepSeekSearchService({ settings: searchSettings, fetchImpl })

test('DeepSeek search request uses official endpoint, bearer auth and maps structured results', async () => {
  const { calls, fetchImpl } = recorder()
  const result = await serviceOf(fetchImpl).search('间谍过家家 第三季 播出时间', { count: 3, needContent: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer deepseek-test-key')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body, { query: '间谍过家家 第三季 播出时间', count: 3, need_content: true })
  assert.equal(result.query, '间谍过家家 第三季 播出时间')
  assert.equal(result.count, 2, '无效链接应被过滤')
  assert.deepEqual(result.results[0], {
    title: '示例条目', url: 'https://example.com/a', snippet: '摘要片段', summary: '较长的摘要内容',
    content: '<p>正文</p>', siteName: 'Example', date: '2026-01-02T03:04:05Z', authority: 3, score: 2.5,
  })
  assert.equal(result.results[1].siteName, null)
  assert.equal(result.results[1].authority, -1)
})

test('search supports a base URL that already ends with /v1 and clamps result count', async () => {
  const settingsV1 = { ...settings, deepseekSearchKey: '', dataDir: path.join(temporary, 'keys-v1') }
  const databaseV1 = createDatabase(':memory:')
  try {
    const local = createSearchSettingsService({ database: databaseV1, settings: settingsV1, aiSettings: { apiKey: () => '' } })
    local.save({ enabled: true, baseUrl: 'https://api.deepseek.com/v1/', count: 5, needContent: false, timeoutMs: 5000, reuseModelKey: false, apiKey: 'k' })
    const { calls, fetchImpl } = recorder()
    await createDeepSeekSearchService({ settings: local, fetchImpl }).search('test', { count: 100 })
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search')
    assert.equal(JSON.parse(calls[0].init.body).count, 50, '超过 50 的条数会被夹到上限')
  } finally { databaseV1.close() }
})

test('query and fetch URL validation rejects unsafe or oversized input before any request', async () => {
  const { calls, fetchImpl } = recorder()
  const service = serviceOf(fetchImpl)
  for (const query of ['', '   ', 'a'.repeat(129), null, 42]) {
    await assert.rejects(service.search(query), (error) => error.code === 'SEARCH_QUERY_INVALID' && error.status === 400)
  }
  assert.equal(calls.length, 0)
  for (const url of ['', 'ftp://example.com/x', 'https://user:pass@example.com/x', 'not-a-url', 'https://' + 'a'.repeat(9000)]) {
    await assert.rejects(service.fetchPage(url), (error) => error.code === 'SEARCH_URL_INVALID' && error.status === 400)
  }
  assert.equal(calls.length, 0)
})

test('fetch page returns markdown content from /v1/tools/fetch', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse({ title: '番剧官网', content: '# 简介\n正文内容' }))
  const page = await serviceOf(fetchImpl).fetchPage('https://example.com/page?x=1#top')
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/fetch')
  assert.deepEqual(JSON.parse(calls[0].init.body), { url: 'https://example.com/page?x=1#top' })
  assert.equal(page.title, '番剧官网')
  assert.equal(page.content, '# 简介\n正文内容')
})

test('upstream failures map to stable SEARCH_ error codes without leaking the key', async () => {
  const cases = [
    { status: 401, code: 'SEARCH_AUTH_FAILED', http: 400 },
    { status: 403, code: 'SEARCH_AUTH_FAILED', http: 400 },
    { status: 429, code: 'SEARCH_RATE_LIMITED', http: 429 },
    { status: 500, code: 'SEARCH_UPSTREAM_UNAVAILABLE', http: 502 },
    { status: 400, code: 'SEARCH_UPSTREAM_REJECTED', http: 502 },
  ]
  for (const item of cases) {
    const { fetchImpl } = recorder(() => jsonResponse({ error: { message: 'upstream said no' } }, item.status))
    await assert.rejects(serviceOf(fetchImpl).search('test'), (error) => {
      assert.equal(error.code, item.code)
      assert.equal(error.status, item.http)
      assert.ok(!String(error.message).includes('deepseek-test-key'))
      return true
    })
  }
  const invalidJson = recorder(() => new Response('not json', { status: 200 }))
  await assert.rejects(serviceOf(invalidJson.fetchImpl).search('test'), (error) => error.code === 'SEARCH_UPSTREAM_INVALID')
  const badShape = recorder(() => jsonResponse({ results: 'nope' }))
  await assert.rejects(serviceOf(badShape.fetchImpl).search('test'), (error) => error.code === 'SEARCH_UPSTREAM_INVALID')
})

test('timeouts and caller aborts surface as SEARCH_TIMEOUT / SEARCH_ABORTED', async () => {
  const hanging = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
  })
  const db = createDatabase(':memory:')
  try {
    const local = createSearchSettingsService({
      database: db,
      settings: { ...settings, searchDefaults: { ...settings.searchDefaults, timeoutMs: 1000 } },
      aiSettings: { apiKey: () => '' },
    })
    local.save({ enabled: true, baseUrl: 'https://api.deepseek.com', count: 1, needContent: false, timeoutMs: 1000, reuseModelKey: false, apiKey: 'k' })
    const service = createDeepSeekSearchService({ settings: local, fetchImpl: hanging })
    const started = Date.now()
    await assert.rejects(service.search('test'), (error) => error.code === 'SEARCH_TIMEOUT' && error.status === 504)
    assert.ok(Date.now() - started >= 900, '应在配置的超时时间后中止请求')

    const controller = new AbortController()
    const pending = service.search('test', { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(pending, (error) => error.code === 'SEARCH_ABORTED')
  } finally { db.close() }
})

test('test() uses the saved key plus unsaved draft overrides without persisting them', async () => {
  const { calls, fetchImpl } = recorder()
  const service = serviceOf(fetchImpl)
  const tested = await service.test({ apiKey: 'unsaved-key', baseUrl: 'https://api.deepseek.com', enabled: true, reuseModelKey: false })
  assert.equal(tested.ok, true)
  assert.equal(tested.provider, 'deepseek')
  assert.equal(tested.count, 2)
  assert.deepEqual(tested.sample[0], { title: '示例条目', url: 'https://example.com/a' })
  assert.ok(tested.latencyMs >= 0)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer unsaved-key')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.count, 1)
  assert.equal(body.need_content, false)
  assert.equal(searchSettings.publicConfig().hasApiKey, true)
})

test('effective() refuses to call DeepSeek when search is disabled or has no key', async () => {
  const db = createDatabase(':memory:')
  try {
    const local = createSearchSettingsService({ database: db, settings, aiSettings: { apiKey: () => '' } })
    const service = createDeepSeekSearchService({ settings: local, fetchImpl: () => jsonResponse({ results: [] }) })
    await assert.rejects(service.search('test'), (error) => error.code === 'SEARCH_DISABLED' && error.status === 409)
    local.save({ enabled: true, baseUrl: 'https://api.deepseek.com', count: 5, needContent: false, timeoutMs: 5000, reuseModelKey: false })
    await assert.rejects(service.search('test'), (error) => error.code === 'SEARCH_NOT_CONFIGURED' && error.status === 409)
  } finally { db.close() }
})
