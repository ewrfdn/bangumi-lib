import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-libraries-'))
const roots = { bangumi: path.join(temporary, 'bangumi'), movie: path.join(temporary, 'movie') }
for (const [id, root] of Object.entries(roots)) {
  await fs.mkdir(path.join(root, 'Series'), { recursive: true })
  await fs.writeFile(path.join(root, 'Series', 'episode.mp4'), `${id}-video`)
  await fs.writeFile(path.join(root, 'Series', 'poster.jpg'), `${id}-poster`)
  await fs.writeFile(path.join(root, 'Series', 'episode.vtt'), `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${id}-subtitle\n`)
}
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.DATA_DIR = path.join(temporary, 'data')
process.env.BANGUMI_LIBRARY = roots.bangumi
process.env.MOVIE_LIBRARY = roots.movie
delete process.env.BANGUMI_ROOT
delete process.env.MEDIA_ROOT
delete process.env.MEDIA_LIBRARIES
const { createApp } = await import('../src/app.ts')
const { parseLibraries } = await import('../src/config.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))

async function makeApp() {
  const app = await createApp({ dbPath: ':memory:', logger: false, authSecret: '' })
  await app.ready()
  return app
}
const query = (library, virtualPath) => new URLSearchParams({ library, path: virtualPath }).toString()

test('libraries are declared in code and read their roots from fixed environment variables', () => {
  const configured = parseLibraries({ BANGUMI_LIBRARY: roots.bangumi, MOVIE_LIBRARY: roots.movie })
  assert.deepEqual(configured.map((library) => [library.id, library.mediaType]), [['bangumi', 'anime'], ['movie', 'movie']])

  // Bangumi always exists and falls back to the historical root variables.
  const fallback = parseLibraries({})
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].id, 'bangumi')
  assert.equal(fallback[0].root, path.resolve(os.homedir(), 'bangumi'))
  assert.equal(parseLibraries({ BANGUMI_ROOT: roots.bangumi })[0].root, roots.bangumi)
  assert.equal(parseLibraries({ BANGUMI_LIBRARY: roots.bangumi, BANGUMI_ROOT: roots.movie })[0].root, roots.bangumi)

  // The movie library only exists when its root is configured.
  assert.equal(parseLibraries({ BANGUMI_LIBRARY: roots.bangumi }).some((library) => library.id === 'movie'), false)

  assert.throws(() => parseLibraries({ MEDIA_LIBRARIES: '[]' }), /MEDIA_LIBRARIES/)
  assert.throws(() => parseLibraries({ BANGUMI_LIBRARY: roots.bangumi, MOVIE_LIBRARY: roots.bangumi }), /重复/)
})

test('libraries, media, posters and subtitles stay scoped to their configured root', async () => {
  const app = await makeApp()
  try {
    const libraries = (await app.inject('/api/libraries')).json()
    assert.equal(libraries.defaultLibraryId, 'bangumi')
    assert.deepEqual(libraries.libraries.map((library) => [library.id, library.available, library.videoCount]), [
      ['bangumi', true, null], ['movie', true, null],
    ])
    const defaultLibrary = (await app.inject('/api/library')).json()
    assert.equal(defaultLibrary.libraryId, 'bangumi')
    for (const [id, label] of [['bangumi', '番剧库'], ['movie', '电影库']]) {
      const library = (await app.inject(`/api/library?library=${id}`)).json()
      assert.equal(library.libraryId, id)
      assert.equal(library.libraryName, label)
      assert.equal(library.series[0].path, '/Series')
      assert.equal(library.series[0].libraryId, id)
      const list = (await app.inject(`/api/list?${query(id, '/Series')}`)).json()
      assert.equal(list.libraryId, id)
      assert.ok(list.items.every((item) => item.libraryId === id))
      const video = await app.inject(`/api/stream?${query(id, '/Series/episode.mp4')}`)
      assert.equal(video.statusCode, 200)
      assert.equal(video.body, `${id}-video`)
      const poster = await app.inject(`/api/file?${query(id, '/Series/poster.jpg')}`)
      assert.equal(poster.statusCode, 200)
      assert.equal(poster.body, `${id}-poster`)
      const subtitle = await app.inject(`/api/subtitle?${query(id, '/Series/episode.vtt')}`)
      assert.equal(subtitle.statusCode, 200)
      assert.match(subtitle.body, new RegExp(`${id}-subtitle`))
      const info = await app.inject(`/api/video?${query(id, '/Series/episode.mp4')}`)
      assert.equal(info.statusCode, 200)
      assert.equal(info.json().libraryId, id)
      assert.equal(info.json().seriesPath, '/Series')
      assert.equal(info.json().seriesTitle, 'Series')
      assert.equal(info.json().poster, '/Series/poster.jpg')
    }
    const cachedLibraries = (await app.inject('/api/libraries')).json().libraries
    assert.deepEqual(cachedLibraries.map((library) => [library.id, library.seriesCount, library.videoCount]), [
      ['bangumi', 1, 1], ['movie', 1, 1],
    ])
  } finally { await app.close() }
})

test('library catalog attaches bound media and series detail exposes episode selection', async () => {
  await fs.mkdir(path.join(roots.bangumi, 'Series', 'Season 1'), { recursive: true })
  await fs.writeFile(path.join(roots.bangumi, 'Series', 'Season 1', 'episode 2.mkv'), 'second')
  await fs.mkdir(path.join(roots.bangumi, 'Unbound'), { recursive: true })
  await fs.writeFile(path.join(roots.bangumi, 'Unbound', '01.mp4'), 'unbound')
  const app = await makeApp()
  try {
    const media = (await app.inject({
      method: 'POST', url: '/api/media',
      payload: { title: '绑定作品', mediaType: 'anime', cover: 'bangumi/1/cover.jpg', season: 1, episodeCount: 2, tags: ['测试'], dataSource: 'bangumi', dataSourceUrl: 'https://bgm.tv/subject/1' },
    })).json().item
    const folder = await app.inject({ method: 'POST', url: '/api/local-media', payload: { libraryId: 'bangumi', folderPath: 'Series', mediaId: media.id } })
    assert.equal(folder.statusCode, 201)
    const folderItem = folder.json().item
    const video = await app.inject({
      method: 'POST', url: '/api/local-media-videos',
      payload: { localMediaId: folderItem.id, mediaPath: 'episode.mp4', videoIndex: 1, coverPath: 'local-media/1/cover.jpg' },
    })
    assert.equal(video.statusCode, 201)
    const extra = await app.inject({
      method: 'POST', url: '/api/local-media-videos',
      payload: {
        localMediaId: folderItem.id, mediaPath: 'Season 1/episode 2.mkv', videoIndex: 2.5, videoType: 'extra',
        durationMs: 720000, width: 1920, height: 1080, frameCount: 17280,
      },
    })
    assert.equal(extra.statusCode, 201)

    const catalog = (await app.inject('/api/library?library=bangumi')).json()
    const bound = catalog.series.find((series) => series.path === '/Series')
    assert.equal(bound.media.id, media.id)
    assert.equal(bound.media.title, '绑定作品')
    assert.equal(bound.mediaCount, 1)
    const unbound = catalog.series.find((series) => series.path === '/Unbound')
    assert.equal(unbound.media, null)
    assert.equal(unbound.mediaCount, 0)

    const detail = (await app.inject(`/api/library/series?${new URLSearchParams({ library: 'bangumi', path: '/Series' })}`)).json()
    assert.equal(detail.media[0].title, '绑定作品')
    assert.equal(detail.videos.length, 2)
    assert.ok(detail.videos.every((video) => video.mediaId === media.id))
    assert.deepEqual(detail.videos.map((video) => video.seasonName).sort(), ['Season 1', '全部剧集'].sort())
    assert.equal(detail.videos.find((video) => video.seasonName === '全部剧集').path, '/Series/episode.mp4')
    assert.equal(detail.videos.find((video) => video.name === 'episode.mp4').coverPath, 'local-media/1/cover.jpg')
    assert.equal(detail.videos.find((video) => video.name === 'episode.mp4').videoType, 'main')
    assert.equal(detail.videos.find((video) => video.name === 'episode.mp4').videoIndex, 1)
    const extraVideo = detail.videos.find((video) => video.name === 'episode 2.mkv')
    assert.equal(extraVideo.videoType, 'extra')
    assert.equal(extraVideo.videoIndex, 2.5)
    assert.equal(extraVideo.durationMs, 720000)
    assert.equal(extraVideo.width, 1920)
    assert.equal(extraVideo.height, 1080)
    assert.equal(extraVideo.frameCount, 17280)

    const unboundDetail = (await app.inject(`/api/library/series?${new URLSearchParams({ library: 'bangumi', path: '/Unbound' })}`)).json()
    assert.equal(unboundDetail.media.length, 0)
    assert.equal(unboundDetail.videos.length, 1)
    assert.equal(unboundDetail.videos[0].mediaId, null)

    assert.equal((await app.inject('/api/library/series?library=bangumi')).statusCode, 400)
    assert.equal((await app.inject(`/api/library/series?${new URLSearchParams({ library: 'bangumi', path: '/No' })}`)).statusCode, 404)
    assert.equal((await app.inject(`/api/library/series?${new URLSearchParams({ library: 'bangumi', path: '/Series', x: '1' })}`)).statusCode, 400)
  } finally { await app.close() }
})

test('scan-generated local covers are served from DATA_DIR/local-media', async () => {
  const directory = path.join(temporary, 'data', 'local-media', '1')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'cover.jpg'), 'local-cover')
  const app = await makeApp()
  try {
    const response = await app.inject('/assets/local-media/1/cover.jpg')
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /^image\/jpeg/)
    assert.equal(response.rawPayload.toString(), 'local-cover')
    assert.equal((await app.inject('/assets/local-media/1/missing.jpg')).statusCode, 404)
  } finally { await app.close() }
})

test('identical virtual paths retain separate progress, library filters and deletion', async () => {
  const app = await makeApp()
  try {
    const record = { path: '/Series/episode.mp4', title: '第一集', duration: 1200, time: 20, seriesPath: '/Series', seriesTitle: 'Series' }
    const savedDefault = await app.inject({ method: 'PUT', url: '/api/progress', payload: record })
    assert.equal(savedDefault.json().item.libraryId, 'bangumi')
    const savedMovie = await app.inject({ method: 'PUT', url: '/api/progress', payload: { ...record, libraryId: 'movie', time: 80 } })
    assert.equal(savedMovie.json().item.libraryId, 'movie')
    const all = (await app.inject('/api/progress')).json().items
    assert.equal(all.length, 2)
    assert.equal(all.find((item) => item.libraryId === 'bangumi').time, 20)
    assert.equal(all.find((item) => item.libraryId === 'movie').time, 80)
    const bangumi = (await app.inject('/api/progress?library=bangumi')).json().items
    assert.equal(bangumi.length, 1)
    assert.equal(bangumi[0].seriesTitle, 'Series')
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/progress?${query('movie', record.path)}` })).statusCode, 200)
    assert.equal((await app.inject('/api/progress?library=bangumi')).json().items.length, 1)
    assert.equal((await app.inject('/api/progress?library=movie')).json().items.length, 0)
  } finally { await app.close() }
})

test('unknown libraries and path escapes cannot fall back into another media root', async () => {
  const app = await makeApp()
  try {
    for (const endpoint of ['library', 'list', 'video', 'file', 'stream', 'subtitle', 'stream-subtitle', 'hls/start', 'progress']) {
      const response = await app.inject(`/api/${endpoint}?${query('unknown', '/Series/episode.mp4')}`)
      assert.equal(response.statusCode, 404, endpoint)
    }
    const missingProgress = await app.inject({ method: 'PUT', url: '/api/progress', payload: { libraryId: 'unknown', path: '/x.mp4', time: 1, duration: 10 } })
    assert.equal(missingProgress.statusCode, 404)
    for (const virtualPath of ['/../movie/Series/poster.jpg', '/..%5Cmovie%5CSeries%5Cposter.jpg', '/Series/episode.mp4:stream']) {
      assert.ok([400, 403].includes((await app.inject(`/api/file?${query('bangumi', virtualPath)}`)).statusCode))
    }
    await fs.symlink(roots.movie, path.join(roots.bangumi, 'escape'), 'junction')
    const escaped = await app.inject(`/api/file?${query('bangumi', '/escape/Series/poster.jpg')}`)
    assert.equal(escaped.statusCode, 403)
    const list = (await app.inject(`/api/list?${query('bangumi', '/')}`)).json()
    assert.ok(list.items.every((item) => item.name !== 'escape'))
  } finally { await app.close() }
})
