import test from 'node:test'
import assert from 'node:assert/strict'
import { BangumiCrawler } from '../src/crawler/bangumi.crawler.ts'
import { CrawlerError } from '../src/crawler/crawler-error.ts'
import { validateMediaDraft } from '../src/crawler/contracts.ts'
import { createCrawlerRegistry } from '../src/crawler/registry.ts'

const subject = overrides => ({ id: 554779, type: 2, name: '生徒会にも穴はある！', name_cn: '学生会也有洞！', eps: 12, total_episodes: 15, date: '2026-10-03', summary: '动画简介', platform: 'TV', images: { large: 'https://lain.bgm.tv/pic/cover/l/example.jpg' }, rating: { total: 100, score: 7.6 }, tags: [{ name: '校园' }, { name: '校园' }, { name: '喜剧' }], infobox: [{ key: '别名', value: [{ v: '学生会' }, { k: '英文名', v: 'Student Council' }] }], ...overrides })
function fixture(response = subject(), config = {}) {
  const calls = []
  let closed = 0
  const httpClient = { async requestJson(url, options) { calls.push({ url, ...options }); return typeof response === 'function' ? response(url, options) : response }, async requestText() { throw new Error('Unexpected text request') }, async close() { closed++ } }
  const crawler = new BangumiCrawler({ enabled: true, userAgent: 'test/bangumi-lib', ...config }, { httpClient, now: () => 1793808000000 })
  return { crawler, calls, get closed() { return closed } }
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof CrawlerError && error.code === code)

test('search sends exactly one page of anime candidates with explicit year filtering', async () => {
  const { crawler, calls } = fixture({ data: [subject(), subject({ id: 502809, platform: 'CM' })], total: 2 })
  const result = await crawler.search({ keyword: ' 学生会 ', year: 2026 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.bgm.tv/v0/search/subjects?limit=5&offset=0')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].retryable, true)
  assert.deepEqual(JSON.parse(calls[0].body), { keyword: '学生会', sort: 'match', filter: { type: [2], air_date: ['>=2026-01-01', '<2027-01-01'] } })
  assert.equal(result.items.length, 2)
  assert.equal(result.items[1].sourceId, '502809')
  assert.equal(result.items[1].platform, 'CM')
  assert.equal(result.items[0].sourceUrl, 'https://bgm.tv/subject/554779')
  assert.ok(calls[0].signal instanceof AbortSignal)
  await crawler.close()
})

test('fetch maps one subject into camelCase draft and declared main episode count', async () => {
  const { crawler, calls } = fixture()
  const draft = await crawler.fetch({ url: 'https://bangumi.tv/subject/554779' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.bgm.tv/v0/subjects/554779')
  assert.deepEqual(draft, {
    title: '学生会也有洞！', mediaType: 'anime', cover: 'https://lain.bgm.tv/pic/cover/l/example.jpg', episodeCount: 12, description: '动画简介', tags: ['校园', '喜剧'], rating: 7.6, airedOn: '2026-10-03', dataSource: 'bangumi', dataSourceUrl: 'https://bgm.tv/subject/554779', attribute: { metadata: { source: 'bangumi', sourceId: '554779', originalTitle: '生徒会にも穴はある！', platform: 'TV', aliases: ['学生会', 'Student Council'], fetchedAt: 1793808000000 } },
  })
  assert.equal(Object.hasOwn(draft, 'id'), false)
  assert.equal(Object.hasOwn(draft, 'season'), false)
  await crawler.close()
})

test('unknown detail values are omitted; total chapters never substitute for unknown eps', async () => {
  const { crawler } = fixture(subject({ name_cn: '', eps: 0, total_episodes: 15, date: '2026-02-30', summary: '', platform: null, images: { large: 'javascript:bad', common: 'https://lain.bgm.tv/cover.jpg' }, rating: { total: 0, score: 0 }, tags: null, infobox: null }))
  const draft = await crawler.fetch({ sourceId: '554779' })
  assert.equal(draft.title, '生徒会にも穴はある！')
  assert.equal(draft.cover, 'https://lain.bgm.tv/cover.jpg')
  for (const field of ['episodeCount', 'description', 'rating', 'tags', 'airedOn', 'season', 'series']) assert.equal(Object.hasOwn(draft, field), false, field)
  assert.equal(Object.hasOwn(draft.attribute.metadata, 'platform'), false)
  assert.equal(Object.hasOwn(draft.attribute.metadata, 'aliases'), false)
  await crawler.close()
})

test('source link and ID validation rejects ambiguity, credentials, spoof hosts and unsafe paths before HTTP', async () => {
  const { crawler, calls } = fixture()
  const bad = [
    {}, { sourceId: '554779', url: 'https://bgm.tv/subject/554779' }, { sourceId: 554779 }, { sourceId: '0' }, { sourceId: '../554779' },
    ...['https://bgm.tv.evil.test/subject/554779', 'https://user:pass@bgm.tv/subject/554779', 'http://127.0.0.1/subject/554779', 'https://bgm.tv:8443/subject/554779', 'https://bgm.tv/subject/554779?next=http://localhost', 'https://bgm.tv/subject/554779#x', 'file:///subject/554779', 'https://bgm.tv/subject/554779/ep', 'https://bgm.tv/subject/0554779', 'https://bgm.tv/foo/../subject/554779', 'https://bgm.tv/%2e%2e/subject/554779', 'https://bgm.tv\\@evil.test/subject/554779'].map(url => ({ url })),
  ]
  for (const params of bad) await rejectsCode(crawler.fetch(params), 'INVALID_INPUT')
  assert.equal(calls.length, 0)
  assert.equal(crawler.parseSourceUrl('http://chii.in/subject/554779/'), '554779')
  await crawler.close()
})

test('search rejects invalid filters rather than silently ignoring them', async () => {
  const { crawler, calls } = fixture()
  await rejectsCode(crawler.search({ keyword: 'x', mediaType: 'movie' }), 'UNSUPPORTED_FILTER')
  await rejectsCode(crawler.search({ keyword: 'x', proxyUrl: 'http://localhost' }), 'UNSUPPORTED_FILTER')
  for (const params of [{ keyword: '' }, { keyword: 'x', limit: 11 }, { keyword: 'x', offset: -1 }, { keyword: 'x', year: '2026' }]) await rejectsCode(crawler.search(params), 'INVALID_INPUT')
  assert.equal(calls.length, 0)
  await crawler.close()
})

test('upstream malformed or mismatched identity is a failure, never an empty draft', async () => {
  for (const response of [subject({ id: 1 }), subject({ type: 1 }), subject({ name: '', name_cn: '' }), null]) {
    const { crawler } = fixture(response)
    await rejectsCode(crawler.fetch({ sourceId: '554779' }), 'INVALID_RESULT')
    await crawler.close()
  }
  const { crawler } = fixture({ data: [subject()], total: -1 })
  await rejectsCode(crawler.search({ keyword: 'x' }), 'INVALID_RESULT')
  await crawler.close()
})

test('template output URL validation classifies invalid upstream links as INVALID_RESULT', async () => {
  const { crawler } = fixture()
  const draft = await crawler.fetch({ sourceId: '554779' })
  crawler._fetch = async () => ({ ...draft, dataSourceUrl: 'https://evil.test/subject/554779' })
  crawler._search = async ({ limit, offset }) => ({ items: [{ source: 'bangumi', sourceId: '554779', sourceUrl: 'https://evil.test/subject/554779', title: 'Example', mediaType: 'anime' }], total: 1, limit, offset })
  await rejectsCode(crawler.fetch({ sourceId: '554779' }), 'INVALID_RESULT')
  await rejectsCode(crawler.search({ keyword: 'Example' }), 'INVALID_RESULT')
  await rejectsCode(crawler.fetch({ url: 'https://evil.test/subject/554779' }), 'INVALID_INPUT')
  await crawler.close()
})

test('operation total deadline cancels the same signal used for queued transport work', async () => {
  let signal
  const { crawler } = fixture((_url, options) => {
    signal = options.signal
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, { operationTimeoutMs: 25 })
  await rejectsCode(crawler.fetch({ sourceId: '554779' }), 'TIMEOUT')
  assert.equal(signal.aborted, true)
  await crawler.close()
})

test('operation budget includes the actual transport interval queue and prevents expired work from starting', async () => {
  let calls = 0
  const crawler = new BangumiCrawler({ operationTimeoutMs: 30, minIntervalMs: 100, maxRetries: 0 }, {
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(subject())) },
    dispatcher: { close: async () => {} },
  })
  await crawler.fetch({ sourceId: '554779' })
  await rejectsCode(crawler.fetch({ sourceId: '554779' }), 'TIMEOUT')
  assert.equal(calls, 1)
  await crawler.close()
})

test('user cancellation and close abort pending work; already cancelled operations make no request', async () => {
  const controller = new AbortController()
  controller.abort(new Error('secret token should not escape'))
  const first = fixture()
  await rejectsCode(first.crawler.fetch({ sourceId: '554779' }, { signal: controller.signal }), 'CANCELLED')
  assert.equal(first.calls.length, 0)
  await first.crawler.close()
  let started
  const ready = new Promise(resolve => { started = resolve })
  const next = fixture((_url, { signal }) => { started(signal); return new Promise(() => {}) })
  const operation = next.crawler.fetch({ sourceId: '554779' })
  const signal = await ready
  await next.crawler.close()
  await rejectsCode(operation, 'CANCELLED')
  assert.equal(signal.aborted, true)
  assert.equal(next.closed, 1)
  await rejectsCode(next.crawler.fetch({ sourceId: '554779' }), 'CANCELLED')
})

test('result contract crops display text and lists, preserving required source identity', async () => {
  const warnings = []
  const { crawler } = fixture()
  const valid = await crawler.fetch({ sourceId: '554779' })
  valid.description = 'x'.repeat(20001)
  valid.tags = Array.from({ length: 101 }, (_, index) => `${index}-${'x'.repeat(70)}`)
  const result = validateMediaDraft(valid, { logger: { warn(...args) { warnings.push(args) } } })
  assert.equal(result.description.length, 20000)
  assert.equal(result.tags.length, 100)
  assert.ok(result.tags.every(tag => tag.length <= 64))
  assert.ok(warnings.length > 0)
  assert.equal(result.attribute.metadata.sourceId, '554779')
  await crawler.close()
})

test('contract rejects local IDs, arbitrary raw attributes and missing source identity', async () => {
  const { crawler } = fixture()
  const draft = await crawler.fetch({ sourceId: '554779' })
  for (const invalid of [{ ...draft, id: 9 }, { ...draft, attribute: { metadata: draft.attribute.metadata, token: 'secret' } }, { ...draft, attribute: { metadata: { source: 'bangumi' } } }, { ...draft, attribute: { metadata: { ...draft.attribute.metadata, rawResponse: {} } } }]) assert.throws(() => validateMediaDraft(invalid), error => error.code === 'INVALID_RESULT')
  await crawler.close()
})

test('malformed optional source lists do not turn unknown tags or aliases into known empty lists', async () => {
  const { crawler } = fixture(subject({ tags: [{ missingName: true }], infobox: [{ key: '别名', value: [{ missingValue: true }] }] }))
  const draft = await crawler.fetch({ sourceId: '554779' })
  assert.equal(Object.hasOwn(draft, 'tags'), false)
  assert.equal(Object.hasOwn(draft.attribute.metadata, 'aliases'), false)
  await crawler.close()
})

test('long multibyte aliases are cropped to fit the catalog attribute byte limit', async () => {
  const { crawler } = fixture()
  const draft = await crawler.fetch({ sourceId: '554779' })
  draft.attribute.metadata.aliases = Array.from({ length: 100 }, (_, index) => `${index}${'中'.repeat(499)}`)
  const result = validateMediaDraft(draft)
  assert.ok(Buffer.byteLength(JSON.stringify(result.attribute), 'utf8') <= 65536)
  assert.ok(result.attribute.metadata.aliases.length < 100)
  assert.equal(result.attribute.metadata.sourceId, '554779')
  await crawler.close()
})

test('registry publishes capabilities without connection secrets and creates only implemented enabled sources', async () => {
  const contexts = [], closed = []
  const registry = createCrawlerRegistry({ bangumi: { enabled: true, token: 'private', proxyUrl: 'http://name:pass@localhost:7890' }, douban: { enabled: true } }, { httpClientFactory(config, context) { contexts.push(context); return { requestJson() {}, requestText() {}, close() { closed.push(context.source) } } } })
  assert.deepEqual(registry.list(), [{ id: 'bangumi', displayName: 'Bangumi 番组计划', mediaTypes: ['anime'], supportsYearFilter: true, supportsOffset: true }])
  assert.deepEqual(contexts[0].allowedOrigins, ['https://api.bgm.tv', 'https://lain.bgm.tv'])
  assert.equal(registry.get('bangumi').id, 'bangumi')
  assert.throws(() => registry.get('douban'), error => error.code === 'UNSUPPORTED_SOURCE')
  assert.throws(() => registry.get('unknown'), error => error.code === 'UNSUPPORTED_SOURCE')
  const descriptors = registry.list()
  descriptors[0].mediaTypes.push('movie')
  assert.deepEqual(registry.list()[0].mediaTypes, ['anime'])
  await registry.close()
  assert.deepEqual(closed, ['bangumi'])
  assert.throws(() => createCrawlerRegistry().get('bangumi'), error => error.code === 'SOURCE_DISABLED')
})

test('crawler errors expose only safe summaries, never nested cause messages or stacks', () => {
  const error = new CrawlerError('PROXY_ERROR', 'bangumi', '代理连接失败', { cause: new Error('http://name:password@proxy.test'), status: 502, retryAfterMs: 1000 })
  assert.equal(error.upstreamStatus, 502)
  assert.equal(JSON.stringify(error).includes('password'), false)
  assert.equal(JSON.stringify(error.cause).includes('password'), false)
})

test('invalid source credentials and header configuration fail before constructing transport', () => {
  let constructed = 0
  const dependencies = { httpClientFactory() { constructed++; throw new Error('must not allocate') } }
  for (const config of [{ userAgent: '' }, { userAgent: 'test\r\nX-Secret: value' }, { token: 'secret\nheader' }]) assert.throws(() => new BangumiCrawler(config, dependencies), error => error.code === 'INVALID_INPUT' && !error.message.includes('secret'))
  assert.equal(constructed, 0)
})
