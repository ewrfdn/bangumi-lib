import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-video-cover-'))
const libraryRoot = path.join(temporary, 'library')
await fs.mkdir(path.join(libraryRoot, 'Show'), { recursive: true })
await fs.mkdir(path.join(libraryRoot, 'Broken'), { recursive: true })
await fs.mkdir(path.join(libraryRoot, 'Classified', '特典'), { recursive: true })
await fs.writeFile(path.join(libraryRoot, 'Show', '01.mp4'), 'episode one')
await fs.writeFile(path.join(libraryRoot, 'Show', '02.mp4'), 'episode two')
await fs.writeFile(path.join(libraryRoot, 'Broken', '01.mp4'), 'episode')
await fs.writeFile(path.join(libraryRoot, 'Classified', '01.mp4'), 'episode one')
await fs.writeFile(path.join(libraryRoot, 'Classified', '02.mp4'), 'episode two')
await fs.writeFile(path.join(libraryRoot, 'Classified', '11.5.mp4'), 'special')
await fs.writeFile(path.join(libraryRoot, 'Classified', '特典', 'NCOP.mp4'), 'creditless opening')

process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.DATA_DIR = path.join(temporary, 'data')
process.env.BANGUMI_LIBRARY = libraryRoot
delete process.env.MOVIE_LIBRARY
const { config } = await import('../src/config.ts')
const { createDatabase } = await import('../src/model/database.ts')
const { createCatalogService } = await import('../src/service/catalog.service.ts')
const { createLocalMediaService } = await import('../src/service/local-media.service.ts')
const { createMediaSyncService } = await import('../src/service/media-sync.service.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))

const database = createDatabase(':memory:')
const models = database.catalog
const catalog = createCatalogService(models)
const localMedia = createLocalMediaService(models, config)

test('binding a folder stores middle-frame cover paths and reuses them until the file changes', async () => {
  const calls = []
  const videoCover = {
    async ensure(videoAbsPath, localMediaId, mediaPath, options) {
      calls.push({ videoAbsPath, localMediaId, mediaPath, options })
      return `local-media/${localMediaId}/${mediaPath}.jpg`
    },
  }
  const mediaSync = createMediaSyncService({ models, settings: config, localMediaService: localMedia, videoCover })
  const media = catalog.create({ title: 'Show', mediaType: 'anime' })

  const first = await mediaSync.bindFolder({ libraryId: 'bangumi', relPath: 'Show', mediaId: media.id })
  assert.equal(first.created, 2)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].videoAbsPath, path.join(libraryRoot, 'Show', '01.mp4'))
  assert.equal(calls[0].mediaPath, '01.mp4')

  const binding = mediaSync.findBinding('bangumi', 'Show')
  const videos = models.videos.list({ limit: 20, offset: 0, filters: { localMediaId: binding.id } }).items
  assert.deepEqual(videos.map((video) => video.coverPath), [
    `local-media/${binding.id}/01.mp4.jpg`,
    `local-media/${binding.id}/02.mp4.jpg`,
  ])

  await mediaSync.syncVideos(binding)
  assert.equal(calls.length, 2, '未变更的视频不重复抽帧')

  const changed = path.join(libraryRoot, 'Show', '01.mp4')
  await fs.utimes(changed, new Date(), new Date(Date.now() + 5000))
  await mediaSync.syncVideos(binding)
  assert.equal(calls.length, 3, '文件变更后重新生成封面')
  assert.equal(calls[2].options.force, true)
})

test('cover generation failure does not fail the video sync', async () => {
  const mediaSync = createMediaSyncService({
    models, settings: config, localMediaService: localMedia,
    videoCover: { async ensure() { return null } },
  })
  const media = catalog.create({ title: 'Broken', mediaType: 'anime' })
  const result = await mediaSync.bindFolder({ libraryId: 'bangumi', relPath: 'Broken', mediaId: media.id })
  assert.equal(result.created, 1)
  const binding = mediaSync.findBinding('bangumi', 'Broken')
  const videos = models.videos.list({ limit: 20, offset: 0, filters: { localMediaId: binding.id } }).items
  assert.equal(videos[0].coverPath, null)
})

test('binding classifies main episodes and specials from the Bangumi episode count', async () => {
  const mediaSync = createMediaSyncService({
    models, settings: config, localMediaService: localMedia,
    videoCover: { async ensure(_abs, localMediaId, mediaPath) { return `local-media/${localMediaId}/${mediaPath}.jpg` } },
  })
  const media = catalog.create({ title: 'Classified', mediaType: 'anime', episodeCount: 2 })
  await mediaSync.bindFolder({ libraryId: 'bangumi', relPath: 'Classified', mediaId: media.id })
  const binding = mediaSync.findBinding('bangumi', 'Classified')
  const videos = models.videos.list({ limit: 20, offset: 0, filters: { localMediaId: binding.id } }).items
  assert.deepEqual(videos.map((video) => [video.mediaPath, video.videoType, video.videoIndex]), [
    ['01.mp4', 'main', 1],
    ['02.mp4', 'main', 2],
    ['11.5.mp4', 'extra', 2.01],
    ['特典/NCOP.mp4', 'extra', 2.02],
  ])

  // 旧记录即使被误标为正片，下一次扫描也会按新的总集数规则修正。
  models.videos.update({ id: videos[2].id }, { videoType: 'main', videoIndex: 3 })
  await mediaSync.syncVideos(binding)
  const fixed = models.videos.find({ id: videos[2].id })
  assert.equal(fixed.videoType, 'extra')
  assert.equal(fixed.videoIndex, 2.01)
})
