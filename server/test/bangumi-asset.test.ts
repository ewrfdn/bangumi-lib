import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-bangumi-asset-'))
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.DATA_DIR = path.join(temporary, 'data')
process.env.BANGUMI_LIBRARY = path.join(temporary, 'media')

const { createDatabase } = await import('../src/model/database.ts')
const { createCatalogService } = await import('../src/service/catalog.service.ts')
const { createBangumiAssetService } = await import('../src/service/bangumi-asset.service.ts')
const { registerAssetsController } = await import('../src/controller/assets.controller.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))

const settings = { dataDir: path.join(temporary, 'data') }
const database = createDatabase(':memory:')
const catalogService = createCatalogService(database.catalog)

const draft = (values = {}) => ({
  title: '葬送的芙莉莲',
  mediaType: 'anime',
  cover: 'https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg',
  episodeCount: 28,
  description: '魔法使的旅途。',
  tags: ['奇幻', '冒险'],
  rating: 8.9,
  airedOn: '2023-09-29',
  dataSource: 'bangumi',
  dataSourceUrl: 'https://bgm.tv/subject/400602',
  attribute: { metadata: { source: 'bangumi', sourceId: '400602', fetchedAt: 1793808000000 } },
  ...values,
})

function fixture(values = {}) {
  let current = draft(values)
  let image = Buffer.from('cover-v1')
  const registry = {
    get(source) {
      assert.equal(source, 'bangumi')
      return {
        async fetch(params) {
          assert.deepEqual(params, { sourceId: '400602' })
          return { ...current }
        },
        async requestImage(url) {
          assert.match(url, /^https:\/\/lain\.bgm\.tv\//)
          return image
        },
      }
    },
  }
  return {
    registry,
    service: createBangumiAssetService({ registry, catalogService, models: database.catalog, settings }),
    set(values) { current = draft(values) },
    setImage(buffer) { image = buffer },
  }
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))

test('a subject is stored on disk and written as one media row', async () => {
  const { service } = fixture()
  const result = await service.importSubject('400602')

  assert.equal(result.created, true)
  assert.equal(result.media.dataSource, 'bangumi')
  assert.equal(result.media.title, '葬送的芙莉莲')
  assert.equal(result.coverPath, 'bangumi/400602/cover.jpg')
  assert.equal(result.media.cover, 'bangumi/400602/cover.jpg')
  assert.equal(result.media.episodeCount, 28)
  assert.equal(result.media.rating, 8.9)

  const directory = path.join(settings.dataDir, 'bangumi', '400602')
  assert.deepEqual(await fs.readFile(path.join(directory, 'cover.jpg'), 'utf8'), 'cover-v1')
  const json = await readJson(path.join(directory, 'subject.json'))
  assert.equal(json.sourceId, '400602')
  assert.equal(json.subject.cover, 'bangumi/400602/cover.jpg')
  assert.equal(json.subject.dataSourceUrl, 'https://bgm.tv/subject/400602')
  assert.equal(database.catalog.media.list({ limit: 10, offset: 0 }).total, 1)
})

test('re-importing the same subject updates in place instead of duplicating', async () => {
  const { service, set } = fixture()
  const first = await service.importSubject('400602')
  set({ title: '葬送的芙莉莲 第二季', episodeCount: 24, rating: 8.5 })
  const second = await service.importSubject('400602')

  assert.equal(second.created, false)
  assert.equal(second.media.id, first.media.id)
  assert.equal(second.media.title, '葬送的芙莉莲 第二季')
  assert.equal(second.media.episodeCount, 24)
  assert.equal(database.catalog.media.list({ limit: 10, offset: 0 }).total, 1)
})

test('local attribute keys survive a refresh and cover bytes are only rewritten when they change', async () => {
  const { service, setImage, set } = fixture()
  const created = await service.importSubject('400602')
  database.catalog.media.update({ id: created.media.id }, { attribute: { ...created.media.attribute, localNote: 'keep' } })

  const cover = path.join(settings.dataDir, 'bangumi', '400602', 'cover.jpg')
  const before = (await fs.stat(cover)).mtimeMs
  await new Promise((resolve) => setTimeout(resolve, 10))
  set({ title: '标题刷新' })
  const refreshed = await service.importSubject('400602')

  assert.equal(refreshed.media.attribute.localNote, 'keep')
  assert.equal(refreshed.media.attribute.metadata.sourceId, '400602')
  assert.equal((await fs.stat(cover)).mtimeMs, before, '相同大小的封面不重复写入')

  setImage(Buffer.from('cover-v2-longer'))
  await service.importSubject('400602')
  assert.equal(await fs.readFile(cover, 'utf8'), 'cover-v2-longer')
})

test('concurrent imports of one subject share a single run', async () => {
  const { service } = fixture()
  const [a, b] = await Promise.all([service.importSubject('400602'), service.importSubject('400602')])
  assert.equal(a.media.id, b.media.id)
  assert.equal(database.catalog.media.list({ limit: 10, offset: 0 }).total, 1)
})

test('invalid identifiers are rejected before any request', async () => {
  const { service } = fixture()
  for (const value of ['', '0', '-1', 'abc', '1e3', '400602/../1']) {
    await assert.rejects(() => service.importSubject(value), { status: 400 })
  }
})

test('assets are served from data/bangumi and cannot escape the directory', async () => {
  const { service } = fixture()
  await service.importSubject('400602')
  await fs.writeFile(path.join(temporary, 'secret.txt'), 'do-not-serve')

  const app = Fastify({ logger: false })
  registerAssetsController(app, { settings })
  await app.ready()
  try {
    const cover = await app.inject('/assets/bangumi/400602/cover.jpg')
    assert.equal(cover.statusCode, 200)
    assert.match(cover.headers['content-type'], /^image\/jpeg/)
    assert.equal(cover.rawPayload.toString(), 'cover-v1')

    const json = await app.inject('/assets/bangumi/400602/subject.json')
    assert.equal(json.statusCode, 200)
    assert.equal(JSON.parse(json.body).sourceId, '400602')

    assert.equal((await app.inject('/assets/bangumi/400602/missing.jpg')).statusCode, 404)
    for (const attack of ['/assets/bangumi/%2e%2e%2fsecret.txt', '/assets/bangumi/..%5csecret.txt', '/assets/bangumi/400602/%00.jpg']) {
      const response = await app.inject(attack)
      assert.ok([400, 403, 404].includes(response.statusCode), `${attack} -> ${response.statusCode}`)
    }
  } finally { await app.close() }
})
