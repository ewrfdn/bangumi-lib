import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../src/model/database.ts'
import { createCatalogService } from '../src/service/catalog.service.ts'
import { createMetadataService } from '../src/service/metadata.service.ts'
import { CrawlerError } from '../src/crawler/crawler-error.ts'

const descriptions = [
  { id: 'bangumi', displayName: 'Bangumi', mediaTypes: ['anime'], supportsYearFilter: true, supportsOffset: true },
  { id: 'douban', displayName: '豆瓣', mediaTypes: ['anime', 'movie'], supportsYearFilter: false, supportsOffset: false },
]
const hosts = { bangumi: ['bgm.tv', 'bangumi.tv', 'chii.in'], douban: ['movie.douban.com'] }
const sourceUrl = (source, sourceId) => `https://${hosts[source][0]}/subject/${sourceId}`
const draft = (source = 'bangumi', sourceId = '400602', values = {}) => ({
  title: '葬送的芙莉莲', dataSource: source, dataSourceUrl: sourceUrl(source, sourceId),
  attribute: { metadata: { source, sourceId, fetchedAt: 1234 } }, ...values,
})

function fixture(t, overrides = {}) {
  const database = createDatabase(':memory:')
  t.after(() => database.close())
  const calls = []
  const crawlers = Object.fromEntries(descriptions.map(info => [info.id, {
    describe: () => ({ ...info }),
    parseSourceUrl(value) {
      let url
      try { url = new URL(value) } catch { throw new CrawlerError('INVALID_INPUT', info.id, '来源链接无效') }
      if (url.protocol !== 'https:' || url.username || url.password || !hosts[info.id].includes(url.hostname) || !/^\/subject\/\d+\/?$/.test(url.pathname)) {
        throw new CrawlerError('INVALID_INPUT', info.id, '来源链接无效')
      }
      return url.pathname.split('/')[2]
    },
    getSourceUrl: id => sourceUrl(info.id, id),
    async search(params, context) {
      calls.push({ type: 'search', source: info.id, params, context })
      return { items: [], total: 0, limit: params.limit, offset: params.offset }
    },
    async fetch(params, context) {
      calls.push({ type: 'fetch', source: info.id, params, context })
      return draft(info.id, params.sourceId ?? this.parseSourceUrl(params.url))
    },
    ...overrides[info.id],
  }]))
  const registry = {
    list: () => descriptions.map(item => ({ ...item })),
    get(source) {
      if (!Object.hasOwn(crawlers, source)) throw new CrawlerError('UNSUPPORTED_SOURCE', source, '不支持的数据源')
      return crawlers[source]
    },
  }
  const catalog = createCatalogService(database.catalog)
  const metadata = createMetadataService({ registry, catalogService: catalog })
  return { database, calls, crawlers, catalog, metadata }
}

test('source discovery and search share one contract, reject per-call transport configuration', async t => {
  const { metadata, calls } = fixture(t)
  assert.deepEqual(metadata.sources(), descriptions)
  const controller = new AbortController()
  assert.deepEqual(await metadata.search({ source: 'bangumi', keyword: ' 芙莉莲 ', year: 2023 }, { signal: controller.signal }),
    { items: [], total: 0, limit: 5, offset: 0 })
  assert.deepEqual(calls[0].params, { keyword: '芙莉莲', year: 2023, mediaType: 'anime', limit: 5, offset: 0 })
  assert.equal(calls[0].context.signal, controller.signal)
  for (const name of ['proxyUrl', 'token', 'headers']) {
    await assert.rejects(metadata.search({ source: 'bangumi', keyword: '芙莉莲', [name]: 'secret' }), { status: 400 })
  }
  assert.equal(calls.length, 1)
  await assert.rejects(metadata.search({ source: 'bangumi', keyword: '芙莉莲', limit: 11 }), { status: 400 })
})

test('preview accepts one reference, verifies identity and returns an ordinary media draft', async t => {
  const { metadata, calls } = fixture(t)
  const result = await metadata.preview({ source: 'bangumi', url: 'https://bangumi.tv/subject/400602/' })
  assert.deepEqual(result, draft())
  assert.equal(calls.length, 1)
  await assert.rejects(metadata.preview({ source: 'bangumi' }), { code: 'INVALID_INPUT' })
  await assert.rejects(metadata.preview({ source: 'bangumi', sourceId: '400602', url: sourceUrl('bangumi', '400602') }), { code: 'INVALID_INPUT' })
  assert.equal(calls.length, 1)
})

test('invalid upstream output remains INVALID_RESULT, while invalid client drafts become INVALID_INPUT', async t => {
  const { metadata, catalog } = fixture(t, { bangumi: { async fetch() { return draft('bangumi', '1', { dataSourceUrl: sourceUrl('bangumi', '2') }) } } })
  await assert.rejects(metadata.preview({ source: 'bangumi', sourceId: '1' }), { code: 'INVALID_RESULT' })
  const local = catalog.create({ title: '本地标题' })
  assert.throws(() => metadata.apply(local.id, { metadata: { ...draft(), id: 42 } }), { code: 'INVALID_INPUT' })
  assert.throws(() => metadata.apply(local.id, { metadata: draft('bangumi', '1', { dataSourceUrl: sourceUrl('bangumi', '2') }) }), { code: 'INVALID_INPUT' })
  assert.throws(() => metadata.apply(local.id, { metadata: draft('bangumi', '1', { dataSourceUrl: 'https://127.0.0.1/subject/1' }) }), { code: 'INVALID_INPUT' })
  assert.equal(catalog.get(local.id).dataSource, null)
})

test('fillMissing preserves local choices and fills only known empty fields, binding source atomically', t => {
  const { metadata, catalog, calls } = fixture(t)
  const local = catalog.create({ title: '本地标题', season: 1, rating: 0, attribute: { custom: { note: 'keep' } } })
  const result = metadata.apply(local.id, { metadata: draft('bangumi', '400602', {
    cover: 'https://images.example/cover.jpg', season: 2, episodeCount: 28, description: '简介', tags: ['奇幻'], rating: 9,
  }) })
  assert.equal(result.title, '本地标题')
  assert.equal(result.season, 1)
  assert.equal(result.rating, 0)
  assert.equal(result.episodeCount, 28)
  assert.equal(result.description, '简介')
  assert.deepEqual(result.tags, ['奇幻'])
  assert.equal(result.dataSource, 'bangumi')
  assert.equal(result.dataSourceUrl, sourceUrl('bangumi', '400602'))
  assert.deepEqual(result.attribute.custom, { note: 'keep' })
  assert.equal(result.attribute.metadata.sourceId, '400602')
  assert.equal(calls.length, 0, 'applying a preview does not perform another network request')
})

test('same-source refresh preserves omitted metadata and content, replacing only selected known values', t => {
  const { metadata, catalog } = fixture(t)
  const local = catalog.create({ ...draft('bangumi', '400602', { description: '旧简介', episodeCount: 28 }),
    attribute: { custom: true, metadata: { ...draft().attribute.metadata, originalTitle: '葬送のフリーレン', aliases: ['Frieren'], platform: 'TV' } } })
  const result = metadata.apply(local.id, { metadata: draft('bangumi', '400602', { cover: 'https://images.example/new.jpg' }), mode: 'overwrite', fields: ['cover', 'description', 'episodeCount'] })
  assert.equal(result.cover, 'https://images.example/new.jpg')
  assert.equal(result.description, '旧简介')
  assert.equal(result.episodeCount, 28)
  assert.deepEqual(result.attribute.metadata.aliases, ['Frieren'])
  assert.equal(result.attribute.metadata.platform, 'TV')
  assert.equal(result.attribute.custom, true)
})

test('source or subject switches require explicit overwrite fields and replace the entire source metadata', t => {
  const { metadata, catalog } = fixture(t)
  const local = catalog.create({ ...draft(), attribute: { custom: 'keep', metadata: { ...draft().attribute.metadata, aliases: ['old'] } } })
  const next = draft('douban', '36176155', { title: '替换标题', cover: 'https://images.example/new.jpg' })
  assert.throws(() => metadata.apply(local.id, { metadata: next }), { code: 'METADATA_SOURCE_CONFLICT', status: 409 })
  assert.throws(() => metadata.apply(local.id, { metadata: draft('bangumi', '515759') }), { code: 'METADATA_SOURCE_CONFLICT' })
  for (const fields of [undefined, [], ['attribute'], ['dataSource'], ['id'], ['attribute.metadata']]) {
    assert.throws(() => metadata.apply(local.id, { metadata: next, mode: 'overwrite', ...(fields === undefined ? {} : { fields }) }), { status: 400 })
  }
  assert.throws(() => metadata.apply(local.id, { metadata: next, mode: null }), { status: 400 })
  const result = metadata.apply(local.id, { metadata: next, mode: 'overwrite', fields: ['cover'] })
  assert.equal(result.title, local.title)
  assert.equal(result.dataSource, 'douban')
  assert.equal(result.dataSourceUrl, sourceUrl('douban', '36176155'))
  assert.deepEqual(result.attribute, { custom: 'keep', metadata: next.attribute.metadata })
})

test('legacy URL bindings can be resolved; unknown or inconsistent old identities never count as empty', t => {
  const { metadata, catalog } = fixture(t)
  const old = catalog.create({ title: '旧资料', dataSource: 'Bangumi', dataSourceUrl: 'https://chii.in/subject/400602/' })
  assert.equal(metadata.apply(old.id, { metadata: draft() }).attribute.metadata.sourceId, '400602')
  for (const values of [
    { dataSource: '旧数据源' },
    { dataSourceUrl: 'https://other.example/subject/400602' },
    { dataSource: 'douban', dataSourceUrl: sourceUrl('bangumi', '400602') },
    { ...draft(), attribute: { metadata: { source: 'bangumi', sourceId: '515759' } } },
  ]) {
    const item = catalog.create({ title: '保留原绑定', ...values })
    assert.throws(() => metadata.apply(item.id, { metadata: draft() }), { code: 'METADATA_SOURCE_CONFLICT' })
    assert.equal(catalog.get(item.id).dataSourceUrl, item.dataSourceUrl)
  }
})

test('cancelled calls do not reach the source or persist metadata, even if a source ignores cancellation', async t => {
  const controller = new AbortController()
  const { metadata, catalog, calls } = fixture(t, { bangumi: { async search() {
    controller.abort()
    return { items: [], total: 0, limit: 5, offset: 0 }
  } } })
  await assert.rejects(metadata.search({ source: 'bangumi', keyword: '芙莉莲' }, { signal: controller.signal }), { code: 'CANCELLED' })
  await assert.rejects(metadata.preview({ source: 'bangumi', sourceId: '400602' }, { signal: controller.signal }), { code: 'CANCELLED' })
  const item = catalog.create({ title: '尚未导入' })
  assert.throws(() => metadata.apply(item.id, { metadata: draft() }, { signal: controller.signal }), { code: 'CANCELLED' })
  assert.equal(catalog.get(item.id).dataSource, null)
  assert.equal(calls.length, 0)
})

test('merged attribute limits roll back import without losing the original record', t => {
  const { metadata, catalog } = fixture(t)
  const local = catalog.create({ title: '原记录', attribute: { custom: 'x'.repeat(65000) } })
  const large = draft()
  large.attribute.metadata.aliases = ['y'.repeat(500), 'z'.repeat(500)]
  assert.throws(() => metadata.apply(local.id, { metadata: large }), { status: 400 })
  assert.deepEqual(catalog.get(local.id), local)
})

test('a failure after the SQL update rolls back content and source identity together', t => {
  const { database, catalog } = fixture(t)
  const local = catalog.create({ title: '原记录' })
  const failingCatalog = createCatalogService({ ...database.catalog, media: { ...database.catalog.media,
    update(key, value) {
      database.catalog.media.update(key, value)
      throw new Error('simulated persistence failure')
    },
  } })
  assert.throws(() => failingCatalog.importMetadata(local.id, { metadata: draft() }), /simulated persistence failure/)
  assert.deepEqual(catalog.get(local.id), local)
})

test('cancellation observed inside the transaction prevents its write', t => {
  const { catalog } = fixture(t)
  const local = catalog.create({ title: '保留' })
  const controller = new AbortController()
  assert.throws(() => catalog.importMetadata(local.id, { metadata: draft() }, { signal: controller.signal,
    resolveIdentity() { controller.abort(); return null },
  }), { code: 'CANCELLED' })
  assert.deepEqual(catalog.get(local.id), local)
})

test('catalog rejects async transactions before any callback or later continuation can write', async t => {
  const { database, catalog } = fixture(t)
  const local = catalog.create({ title: '同步事务' })
  let entered = false
  assert.throws(() => database.catalog.transaction(async () => {
    entered = true
    await Promise.resolve()
    catalog.update(local.id, { title: '不应在事务外写入' })
  }), /must be synchronous/)
  await Promise.resolve()
  assert.equal(entered, false)
  assert.deepEqual(catalog.get(local.id), local)
  assert.throws(() => database.catalog.transaction(() => {
    catalog.update(local.id, { title: '不应提交' })
    return Promise.resolve()
  }), /must be synchronous/)
  assert.deepEqual(catalog.get(local.id), local)
})
