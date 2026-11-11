import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-media-scan-'))
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.DATA_DIR = path.join(temporary, 'data')
process.env.BANGUMI_LIBRARY = path.join(temporary, 'library')

const libraryRoot = path.join(temporary, 'library')
await fs.mkdir(path.join(libraryRoot, 'Show A', 'Season 1'), { recursive: true })
await fs.mkdir(path.join(libraryRoot, 'Editable'), { recursive: true })
await fs.writeFile(path.join(libraryRoot, 'Show A', 'Season 1', '01.mkv'), 'episode one')
await fs.writeFile(path.join(libraryRoot, 'Show A', 'Season 1', '02.mkv'), 'episode two')
await fs.writeFile(path.join(libraryRoot, 'Show A', 'Season 1', '01.ass'), 'subtitle')
await fs.writeFile(path.join(libraryRoot, 'Editable', '01.mkv'), 'editable')

const { config } = await import('../src/config.ts')
const { createDatabase } = await import('../src/model/database.ts')
const { createCatalogService } = await import('../src/service/catalog.service.ts')
const { createLocalMediaService } = await import('../src/service/local-media.service.ts')
const { createMediaSyncService } = await import('../src/service/media-sync.service.ts')
const { createLibFolderService } = await import('../src/service/lib-folder.service.ts')
const { createScanService } = await import('../src/service/scan.service.ts')
const { createMediaScanTools } = await import('../src/agent/tools/media-scan.tools.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))

const database = createDatabase(':memory:')
const models = database.catalog
const catalog = createCatalogService(models)
const localMedia = createLocalMediaService(models, config)
const mediaSync = createMediaSyncService({ models, settings: config, localMediaService: localMedia })
const libFolder = createLibFolderService({ models: database, settings: config })
const library = config.getLibrary('bangumi')

const services = { catalog, metadata: {}, bangumiAsset: {} }
const tools = createMediaScanTools({ library, services, models, mediaSync })
const tool = (name) => tools.find((item) => item.name === name)
const run = (name, params) => tool(name).execute('call-1', params, new AbortController().signal).then((result) => result.details)

test('list_folder returns direct children without the subtitle noise of nested folders', async () => {
  const root = await run('list_folder', { path: '' })
  assert.deepEqual(root.items.map((item) => item.name), ['Editable', 'Show A'])

  const season = await run('list_folder', { path: 'Show A/Season 1' })
  assert.deepEqual(season.items.map((item) => [item.name, item.kind]), [
    ['01.ass', 'file'], ['01.mkv', 'file'], ['02.mkv', 'file'],
  ])
  await assert.rejects(() => run('list_folder', { path: 'Nope' }), { status: 404 })
  await assert.rejects(() => run('list_folder', { path: '../outside' }), { status: 400 })
})

test('create_media_from_folder records an unknown work that is distinguishable from a real source', async () => {
  const created = await run('create_media_from_folder', { path: 'Show A' })
  assert.equal(created.needsReview, true)
  assert.equal(created.title, 'Show A')

  const media = models.media.find({ id: created.mediaId })
  assert.equal(media.dataSource, null)
  assert.deepEqual(media.attribute.scan, { origin: 'folder_name', needsReview: true, folderPath: 'Show A' })

  await assert.rejects(() => run('create_media_from_folder', { path: '' }), { status: 400 })
})

test('sync_local_media binds the folder and only ingests video files', async () => {  const media = catalog.create({ title: 'Show A', mediaType: 'anime' })
  const first = await run('sync_local_media', { path: 'Show A/Season 1', mediaId: media.id })

  assert.equal(first.total, 2)
  assert.equal(first.created, 2)
  assert.equal(first.missing, 0)
  const videos = models.videos.list({ limit: 20, offset: 0, filters: { localMediaId: first.localMediaId } }).items
  assert.deepEqual(videos.map((video) => [video.mediaPath, video.videoIndex, video.missing]), [
    ['01.mkv', 1, false], ['02.mkv', 2, false],
  ])

  const again = await run('sync_local_media', { path: 'Show A/Season 1', mediaId: media.id })
  assert.equal(again.total, 2)
  assert.equal(again.created, 0)

  await fs.rm(path.join(libraryRoot, 'Show A', 'Season 1', '02.mkv'))
  const removed = await run('sync_local_media', { path: 'Show A/Season 1', mediaId: media.id })
  assert.equal(removed.missing, 1)
  assert.equal(models.videos.find({ id: videos[1].id }).missing, true)
})

test('report terminates the tool batch', async () => {
  const result = await tool('report').execute('call-1', { kind: 'container', summary: '交给子目录' })
  assert.equal(result.terminate, true)
  assert.equal(result.details.kind, 'container')
})

test('scan sends changed folders to the agent and only syncs folders already bound to a source', async () => {
  const calls = []
  const roots = []
  const mediaAgent = { enabled: () => true, async classify(context) { calls.push(context.folder.relPath); roots.push(context.library.root) } }
  const scanner = createScanService({ libFolderService: libFolder, mediaSync, models, settings: config, mediaAgent })

  const first = await scanner.scanLibrary('bangumi', { maxDepth: 3 })
  assert.ok(calls.includes('Show A/Season 1'), '未绑定目录交给 Agent')
  assert.ok(first.visited >= 3)
  assert.ok(roots.length > 0)
  assert.equal(roots.every((root) => root === library.root), true, 'Agent 必须拿到媒体库根目录')

  const media = catalog.create({
    title: '埋葬的芙莉莲', mediaType: 'anime',
    dataSource: 'bangumi', dataSourceUrl: 'https://bgm.tv/subject/400602',
    attribute: { metadata: { source: 'bangumi', sourceId: '400602' } },
  })
  await mediaSync.bindFolder({ libraryId: 'bangumi', relPath: 'Show A/Season 1', mediaId: media.id })

  await fs.writeFile(path.join(libraryRoot, 'Show A', 'Season 1', '03.mkv'), 'episode three')
  calls.length = 0
  const second = await scanner.scanLibrary('bangumi', { maxDepth: 3 })
  assert.deepEqual(calls, [], '已绑定目录不再调用 Agent')
  assert.equal(second.synced, 1)
  const videos = models.videos.list({ limit: 20, offset: 0, filters: { localMediaId: mediaSync.findBinding('bangumi', 'Show A/Season 1').id } }).items
  assert.equal(videos.length, 3)
})

test('only the folder level that directly contains videos is sent to the agent', async () => {
  await fs.mkdir(path.join(libraryRoot, 'Bundled', 'Group'), { recursive: true })
  await fs.writeFile(path.join(libraryRoot, 'Bundled', 'Group', '01.mkv'), 'episode')

  const calls = []
  const mediaAgent = { enabled: () => true, async classify(context) { calls.push(context.folder.relPath) } }
  const scanner = createScanService({ libFolderService: libFolder, mediaSync, models, settings: config, mediaAgent })
  await scanner.scanLibrary('bangumi', { maxDepth: 3 })

  assert.equal(calls.includes('Bundled'), false, '纯容器目录不调用 Agent')
  assert.ok(calls.includes('Bundled/Group'), '视频所在层交给 Agent，绑定路径即该目录')
})

test('agent receives ancestor bindings for a subfolder of a bound work and does not duplicate the binding', async () => {
  const parent = catalog.create({
    title: 'Show A 合集', mediaType: 'anime',
    dataSource: 'bangumi', dataSourceUrl: 'https://bgm.tv/subject/400602',
    attribute: { metadata: { source: 'bangumi', sourceId: '400602' } },
  })
  await mediaSync.bindFolder({ libraryId: 'bangumi', relPath: 'Show A', mediaId: parent.id })
  await fs.mkdir(path.join(libraryRoot, 'Show A', 'Season 2'), { recursive: true })
  await fs.writeFile(path.join(libraryRoot, 'Show A', 'Season 2', '01.mkv'), 'episode')

  const calls = []
  const mediaAgent = { enabled: () => true, async classify(context) { calls.push(context) } }
  const scanner = createScanService({ libFolderService: libFolder, mediaSync, models, settings: config, mediaAgent })
  await scanner.scanLibrary('bangumi', { maxDepth: 3 })

  const call = calls.find((context) => context.folder.relPath === 'Show A/Season 2')
  assert.ok(call, '位于已绑定作品内部的视频目录仍交给 Agent 判定')
  assert.deepEqual(call.ancestors.map((item) => item.path), ['Show A'], '祖先绑定信息随上下文传入')
  assert.equal(call.ancestors[0].mediaId, parent.id)
  assert.equal(call.ancestors[0].title, 'Show A 合集')
  assert.equal(mediaSync.findBinding('bangumi', 'Show A/Season 2'), null, '不应产生重复绑定')
  const videos = models.videos.list({ limit: 50, offset: 0, filters: { mediaId: parent.id } }).items
  assert.ok(videos.some((video) => video.mediaPath.includes('Season 2')), '子目录视频由祖先绑定递归同步')
})

test('media scan tools reject a library without a root instead of failing on path.resolve', () => {
  assert.throws(
    () => createMediaScanTools({ library: { id: 'bangumi', name: '番剧库' }, services, models, mediaSync }),
    /缺少根目录/,
  )
})

test('media scan tools expose and correct video type/index for ambiguous folders', async () => {
  const media = catalog.create({ title: 'Editable', mediaType: 'anime' })
  await run('sync_local_media', { path: 'Editable', mediaId: media.id })
  const binding = await run('get_folder_binding', { path: 'Editable' })
  const first = binding.videos[0]
  assert.equal(first.type, 'main')
  assert.equal(first.id > 0, true)

  const updated = await run('update_videos', { videos: [{ id: first.id, videoType: 'extra', videoIndex: 12.5 }] })
  assert.equal(updated.count, 1)
  const after = await run('get_folder_binding', { path: 'Editable' })
  assert.equal(after.videos[0].type, 'extra')
  assert.equal(after.videos[0].index, 12.5)
})

test('a disabled agent defers new folders instead of marking them processed', async () => {
  await fs.mkdir(path.join(libraryRoot, 'Show B'), { recursive: true })
  await fs.writeFile(path.join(libraryRoot, 'Show B', 'movie.mkv'), 'movie')

  const mediaAgent = { enabled: () => false, async classify() { throw new Error('should not run') } }
  const scanner = createScanService({ libFolderService: libFolder, mediaSync, models, settings: config, mediaAgent })

  const summary = await scanner.scanLibrary('bangumi', { maxDepth: 3 })
  assert.ok(summary.deferred >= 1)
  assert.ok(summary.failed >= 1)
  const row = database.libFolder.find('bangumi', 'Show B')
  assert.equal(row.status, 'failed')
  assert.match(row.error, /未启用/)
})
