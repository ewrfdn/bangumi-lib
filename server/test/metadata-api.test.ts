import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-metadata-api-'))
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.BANGUMI_ROOT = temporary
process.env.DATA_DIR = path.join(temporary, 'data')
delete process.env.MEDIA_LIBRARIES
const { createApp } = await import('../src/app.ts')
const { parseCrawlerConfig } = await import('../src/config.ts')
const { CrawlerError } = await import('../src/crawler/crawler-error.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))

const subject = {
  id: 400602, type: 2, name: '葬送のフリーレン', name_cn: '葬送的芙莉莲',
  summary: '精灵与伙伴们的旅程', date: '2023-09-29', platform: 'TV',
  eps: 28, total_episodes: 35, images: { large: 'https://lain.bgm.tv/cover.jpg' },
  rating: { score: 9, total: 100 }, tags: [{ name: '奇幻' }],
}

async function application(options = {}) {
  const calls = []
  let closed = 0
  const app = await createApp({
    logger: false, dbPath: ':memory:', authSecret: '',
    crawlers: parseCrawlerConfig({ BANGUMI_CRAWLER_TOKEN: 'private-source-token' }),
    crawlerDependencies: {
      httpClientFactory() {
        return {
          async requestJson(url, request = {}) {
            calls.push({ url: String(url), request })
            if (String(url).includes('/search/')) return { total: 1, data: [subject] }
            return subject
          },
          async close() { closed++ },
        }
      },
    },
    ...options,
  })
  return { app, calls, closed: () => closed }
}

async function request(app, method, url, payload, status = 200, headers) {
  const response = await app.inject({ method, url, payload, headers })
  assert.equal(response.statusCode, status, response.body)
  return response
}

test('crawler environment settings are independent, bounded and reject invalid settings without leaking secrets', () => {
  const settings = parseCrawlerConfig({
    BANGUMI_CRAWLER_PROXY_URL: 'http://user:proxy-secret@127.0.0.1:7890',
    BANGUMI_CRAWLER_TIMEOUT_MS: '12000',
    DOUBAN_CRAWLER_TIMEOUT_MS: '21000',
  })
  assert.equal(settings.bangumi.timeoutMs, 12000)
  assert.equal(settings.douban.timeoutMs, 21000)
  assert.equal(settings.douban.proxyUrl, null)
  assert.equal(settings.douban.enabled, false)
  for (const env of [
    { BANGUMI_CRAWLER_TIMEOUT_MS: 'NaN' },
    { BANGUMI_CRAWLER_ENABLED: 'yes' },
    { BANGUMI_CRAWLER_MAX_RETRIES: '100' },
    { BANGUMI_CRAWLER_PROXY_URL: 'file:///proxy-secret' },
    { BANGUMI_CRAWLER_PROXY_URL: 'http://127.0.0.1/proxy-secret' },
    { BANGUMI_CRAWLER_USER_AGENT: 'bad\r\nheader' },
  ]) {
    assert.throws(() => parseCrawlerConfig(env), error => !error.message.includes('proxy-secret'))
  }
})

test('search and preview expose media drafts without persistence, then import only selected fields', async () => {
  const { app, calls, closed } = await application()
  try {
    const sources = await request(app, 'GET', '/api/metadata/sources')
    assert.ok(sources.json().items.some(item => item.id === 'bangumi'))
    assert.equal(sources.headers['cache-control'], 'no-store')
    assert.ok(!sources.body.includes('private-source-token'))
    const search = (await request(app, 'POST', '/api/metadata/search', { source: 'bangumi', keyword: '芙莉莲' })).json()
    assert.equal(search.items[0].sourceId, '400602')
    assert.equal(search.items[0].title, '葬送的芙莉莲')
    const preview = (await request(app, 'POST', '/api/metadata/preview', {
      source: 'bangumi', url: 'https://bgm.tv/subject/400602',
    })).json().item
    assert.equal(preview.episodeCount, 28)
    assert.equal(preview.dataSource, 'bangumi')
    assert.equal(preview.dataSourceUrl, 'https://bgm.tv/subject/400602')
    assert.equal(preview.attribute.metadata.sourceId, '400602')
    assert.equal((await request(app, 'GET', '/api/media')).json().total, 0)
    const local = (await request(app, 'POST', '/api/media', {
      title: '本地文件夹名', season: 2, attribute: { custom: 'keep' },
    }, 201)).json().item
    const imported = (await request(app, 'POST', '/api/media/' + local.id + '/metadata', {
      metadata: preview, mode: 'overwrite', fields: ['title', 'cover', 'episodeCount'],
    })).json().item
    assert.equal(imported.id, local.id)
    assert.equal(imported.title, '葬送的芙莉莲')
    assert.equal(imported.season, 2)
    assert.equal(imported.episodeCount, 28)
    assert.equal(imported.attribute.custom, 'keep')
    assert.equal(imported.attribute.metadata.sourceId, '400602')
    assert.equal(imported.dataSource, 'bangumi')
    assert.equal(imported.dataSourceUrl, 'https://bgm.tv/subject/400602')
    assert.equal(imported.description, '')
    const saved = (await request(app, 'GET', '/api/media/' + local.id)).json().item
    assert.equal(saved.dataSource, 'bangumi')
    assert.equal(saved.dataSourceUrl, 'https://bgm.tv/subject/400602')
    assert.equal(calls.length, 2)
    for (const payload of [
      { source: 'bangumi', keyword: 'x', proxyUrl: 'http://untrusted.test' },
      { source: 'bangumi', keyword: 'x', limit: 11 },
    ]) await request(app, 'POST', '/api/metadata/search', payload, 400)
    for (const payload of [
      { source: 'bangumi', sourceId: '400602', url: 'https://bgm.tv/subject/400602' },
      { source: 'bangumi', url: 'http://127.0.0.1/private' },
    ]) await request(app, 'POST', '/api/metadata/preview', payload, 400)
    assert.equal(calls.length, 2)
    await request(app, 'POST', '/api/media/' + local.id + '/metadata', {
      metadata: { ...preview, id: 999 }, mode: 'overwrite', fields: ['title'],
    }, 400)
  } finally { await app.close() }
  assert.equal(closed(), 1)
})

test('metadata routes share key login and reject cross-site mutations before accessing the source', async () => {
  const { app, calls } = await application({ authSecret: 'metadata-key' })
  try {
    for (const [method, url] of [
      ['GET', '/api/metadata/sources'], ['POST', '/api/metadata/search'],
      ['POST', '/api/metadata/preview'], ['POST', '/api/media/1/metadata'],
    ]) await request(app, method, url, method === 'GET' ? undefined : {}, 401)
    const login = await request(app, 'POST', '/api/auth/login', { key: 'metadata-key' })
    const cookie = login.headers['set-cookie'].split(';')[0]
    await request(app, 'POST', '/api/metadata/search', {
      source: 'bangumi', keyword: '芙莉莲',
    }, 403, { cookie, origin: 'https://untrusted.example' })
    await request(app, 'GET', '/api/metadata/sources', undefined, 200, { cookie })
    assert.equal(calls.length, 0)
  } finally { await app.close() }
})

test('upstream rate limits retain safe code and retry delay; disabled sources do not call the network', async () => {
  const registry = {
    list: () => [],
    get: source => {
      if (source === 'douban') throw new CrawlerError('SOURCE_DISABLED', source, '来源未启用')
      return {
        describe: () => ({ id: source }),
        search: async () => { throw new CrawlerError('RATE_LIMITED', source, '来源请求过于频繁', { retryAfterMs: 2100 }) },
      }
    },
    close: async () => {},
  }
  const { app } = await application({ crawlerRegistry: registry })
  try {
    const limited = await request(app, 'POST', '/api/metadata/search', { source: 'bangumi', keyword: 'x' }, 429)
    assert.equal(limited.json().source, 'bangumi')
    assert.equal(limited.json().code, 'RATE_LIMITED')
    assert.equal(limited.headers['retry-after'], '3')
    await request(app, 'POST', '/api/metadata/search', { source: 'douban', keyword: 'x' }, 503)
  } finally { await app.close() }
})

test('client disconnect and application close cancel in-flight crawler operations', { timeout: 5000 }, async () => {
  for (const action of ['disconnect', 'close']) {
    let startedResolve, abortedResolve
    const started = new Promise(resolve => { startedResolve = resolve })
    const aborted = new Promise(resolve => { abortedResolve = resolve })
    const { app } = await application({
      crawlerDependencies: {
        httpClientFactory() {
          return {
            requestJson(url, { signal }) {
              startedResolve()
              return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                  abortedResolve(true)
                  reject(signal.reason)
                }, { once: true })
              })
            },
            async close() {},
          }
        },
      },
    })
    let outgoing
    try {
      await app.listen({ host: '127.0.0.1', port: 0 })
      const body = JSON.stringify({ source: 'bangumi', keyword: '芙莉莲' })
      outgoing = http.request({
        host: '127.0.0.1', port: app.server.address().port,
        method: 'POST', path: '/api/metadata/search',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, response => response.resume())
      outgoing.on('error', () => {})
      outgoing.end(body)
      await started
      const closing = action === 'close' ? app.close() : undefined
      if (action === 'disconnect') outgoing.destroy()
      let timer
      const observed = await Promise.race([
        aborted,
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 500) }),
      ])
      clearTimeout(timer)
      assert.equal(observed, true, action + ' did not cancel the upstream operation')
      await closing
    } finally {
      outgoing?.destroy()
      await app.close()
    }
  }
})
