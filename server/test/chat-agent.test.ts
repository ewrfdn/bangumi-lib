import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-chat-agent-'))
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.DATA_DIR = path.join(temporary, 'data')
process.env.BANGUMI_LIBRARY = path.join(temporary, 'library')

const libraryRoot = path.join(temporary, 'library')
await fs.mkdir(path.join(libraryRoot, 'Show A', 'Season 1'), { recursive: true })
await fs.writeFile(path.join(libraryRoot, 'Show A', 'Season 1', '01.mkv'), 'episode one')
await fs.writeFile(path.join(libraryRoot, 'Show A', 'Season 1', '02.mkv'), 'episode two')
await fs.writeFile(path.join(libraryRoot, 'Show A', 'Season 1', '01.ass'), 'subtitle')

const { config } = await import('../src/config.ts')
const { createDatabase } = await import('../src/model/database.ts')
const { createCatalogService } = await import('../src/service/catalog.service.ts')
const { createTaskService } = await import('../src/service/task.service.ts')
const { ChatAgent } = await import('../src/agent/agents/chat.agent.ts')
const { createChatTools } = await import('../src/agent/tools/chat.tools.ts')

after(() => fs.rm(temporary, { recursive: true, force: true }))

const database = createDatabase(':memory:')
const models = database.catalog
const catalog = createCatalogService(models)
const task = createTaskService(models)
const library = config.getLibrary('bangumi')

// ---- 最小依赖：真实 catalog/task 服务 + 其余服务的小 stub（不依赖 app.ts / WebSocket） ----
const librariesResult = {
  defaultLibraryId: library.id,
  libraries: [{ ...library, available: true, seriesCount: 2, videoCount: 4 }],
}

const statusResult = {
  ok: true, root: library.root, rootExists: true, defaultLibraryId: library.id,
  libraries: [{ ...library, available: true }],
  ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe', hwaccels: ['vaapi'], encoders: ['libx264'],
  transcode: { encoder: 'libx264', software: true }, probeLatencyMs: 12,
  database: { type: 'sqlite', path: ':memory:', schemaVersion: 7, progressCount: 0 },
  authEnabled: false, version: '0.1.0',
}

const catalogResult = {
  root: library.root, libraryId: library.id, libraryName: library.name, available: true,
  series: [
    {
      name: 'Show A', path: '/Show A', libraryId: library.id, kind: 'dir', count: 2,
      poster: null, media: null, mediaCount: 0, localCover: null,
    },
  ],
}

const folderResult = {
  path: '/Show A', root: library.root, libraryId: library.id, libraryName: library.name,
  items: [{ name: 'Season 1', path: '/Show A/Season 1', libraryId: library.id, kind: 'dir', ext: '', count: 2 }],
}

let schedulerSkipped = false
const schedulerRuns = []

const services = {
  catalog,
  task,
  library: {
    async libraries() { return librariesResult },
    async status() { return statusResult },
    async catalog() { return catalogResult },
    async list() { return folderResult },
  },
  metadata: {
    async search(body) {
      return {
        total: 1, limit: body.limit ?? 5, offset: 0,
        items: [{
          source: 'bangumi', sourceId: '400602', sourceUrl: 'https://bgm.tv/subject/400602',
          title: '葬送的芙莉莲', originalTitle: '葬送のフリーレン', mediaType: 'anime', platform: 'TV',
          airedOn: '2023-09-29', cover: 'https://lain.bgm.tv/pic/cover/l/frieren.jpg',
        }],
      }
    },
  },
  bangumiAsset: {
    async importSubject(subjectId) {
      const media = catalog.create({ title: `抓取 ${subjectId}`, mediaType: 'anime' })
      return { media, created: true, coverPath: `bangumi/${subjectId}/cover.jpg`, jsonPath: `bangumi/${subjectId}/subject.json` }
    },
  },
  mediaSync: {
    findBinding() { return null },
    async bindFolder(input) {
      return { localMediaId: 7, mediaId: input.mediaId, total: 2, created: 2, updated: 0, missing: 0 }
    },
  },
  progress: {
    list() {
      return [{
        libraryId: library.id, path: '/Show A/Season 1/01.mkv', title: '01.mkv', time: 300, duration: 1200,
        at: Date.now(), hevc: false, poster: null, seriesPath: '/Show A', seriesTitle: 'Show A',
      }]
    },
  },
  scheduler: {
    list() {
      return [{
        type: 'scan_library', cron: '0 3 * * *', enabled: true, options: { maxDepth: 3 },
        timeoutMs: 900000, running: false, nextRun: null,
      }]
    },
    async runNow(type, options) {
      schedulerRuns.push({ type, options })
      if (schedulerSkipped) return { skipped: true }
      return { taskId: 88 }
    },
    get timezone() { return 'Asia/Shanghai' },
  },
  scan: {
    async scanLibrary() { return { libraryId: library.id } },
  },
  taskRunner: {
    start(_options, handler) {
      void handler({ signal: new AbortController().signal })
      return { ok: true, taskId: 42, promise: Promise.resolve({ ok: true, taskId: 42 }) }
    },
  },
}

const tools = createChatTools({ services, models, settings: config })
const tool = (name) => {
  const found = tools.find((item) => item.name === name)
  assert.ok(found, `缺少工具：${name}`)
  return found
}
const run = (name, params = {}) => tool(name).execute('call-1', params, new AbortController().signal)
const details = async (name, params = {}) => (await run(name, params)).details

const agent = new ChatAgent({ services, models, settings: config })

const READ_TOOLS = [
  'list_libraries', 'get_status', 'browse_library', 'search_media', 'list_media', 'get_media',
  'list_folder', 'get_folder_binding', 'search_bangumi', 'list_watch_progress', 'list_tasks', 'get_task',
  'list_scheduler_tasks',
]
const WRITE_TOOLS = [
  'crawl_bangumi', 'create_media', 'update_media', 'sync_local_media', 'scan_library',
  'run_scheduler_task', 'cancel_task',
]
const EXPECTED_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS]

test('ChatAgent 拆分系统提示词、最新提问与历史轮次', () => {
  assert.equal(agent.type, 'chat')
  assert.equal(agent.label, '媒体助手')
  assert.equal(agent.maxTurns, 10)
  assert.equal(agent.maxToolCalls, 32)
  assert.equal(agent.timeoutMs, 120_000)

  const systemPrompt = agent.systemPrompt()
  assert.match(systemPrompt, /媒体助手/)
  assert.match(systemPrompt, /不要编造/)
  assert.match(systemPrompt, /没有删除工具/)
  assert.match(systemPrompt, /不要泄露/)

  const messages = [
    { role: 'user', content: '最近看了什么？' },
    { role: 'assistant', content: '你最近看了《Show A》。' },
    { role: 'user', content: '那第二部呢？' },
  ]
  assert.equal(agent.userPrompt({ messages }), '那第二部呢？')
  assert.deepEqual(agent.history({ messages }), messages.slice(0, 2))
  assert.deepEqual(agent.history({ messages: [{ role: 'user', content: '你好' }] }), [])

  assert.throws(() => agent.userPrompt({ messages: [] }), /用户提问/)
  assert.throws(() => agent.userPrompt({ messages: [{ role: 'assistant', content: '你好' }] }), /用户提问/)
  assert.throws(() => agent.userPrompt({ messages: [{ role: 'user', content: '   ' }] }), /用户提问/)
  assert.throws(() => agent.userPrompt({ messages: null }), /用户提问/)
})

test('工具清单恰好 20 个、包含全部名称且没有删除工具', () => {
  assert.deepEqual(tools.map((item) => item.name), EXPECTED_TOOLS)
  assert.equal(tools.length, 20)
  for (const item of tools) {
    assert.ok(item.label, `${item.name} 缺少 label`)
    assert.ok(item.description, `${item.name} 缺少 description`)
    assert.equal(typeof item.execute, 'function')
    assert.equal(item.parameters.type, 'object')
    assert.ok(Object.hasOwn(item.parameters.properties, 'library'), `${item.name} 缺少 library 参数`)
    assert.ok(!(item.parameters.required ?? []).includes('library'), `${item.name} 的 library 不应必填`)
    assert.doesNotMatch(item.name, /delete|remove|drop|trash/i)
  }
  for (const name of WRITE_TOOLS) assert.equal(tool(name).executionMode, 'sequential', `${name} 必须串行执行`)
  // Agent 按 context 构建工具，空历史也能构建。
  assert.deepEqual(agent.tools({ messages: [] }).map((item) => item.name), EXPECTED_TOOLS)
})

test('工具结果统一为 JSON 文本，非法媒体库友好报错', async () => {
  const result = await run('list_libraries')
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'text')
  const parsed = JSON.parse(result.content[0].text)
  assert.deepEqual(parsed, result.details)
  assert.equal(parsed.defaultLibraryId, 'bangumi')
  assert.equal(parsed.libraries[0].id, 'bangumi')
  assert.equal(parsed.libraries[0].seriesCount, 2)

  await assert.rejects(run('list_libraries', { library: 'nope' }), { status: 404 })
  await assert.rejects(run('get_status', { library: 'movie' }), { status: 404 })
  await assert.rejects(run('list_libraries', { library: 'x'.repeat(100) }), { status: 404 })
  // 空 library 回退到默认媒体库。
  assert.equal((await details('list_libraries', { library: '   ' })).currentLibraryId, 'bangumi')
})

test('search_media / create_media / update_media 读写真实服务', async () => {
  const created = await details('create_media', {
    title: '  测试作品  ', mediaType: 'anime', season: 2, episodeCount: 12, tags: ['A', 'B'],
  })
  assert.equal(created.title, '测试作品')
  assert.equal(created.needsReview, false)
  assert.equal(typeof created.mediaId, 'number')
  const stored = models.media.find({ id: created.mediaId })
  assert.equal(stored.title, '测试作品')
  assert.equal(stored.season, 2)
  assert.deepEqual(stored.tags, ['A', 'B'])

  const found = await details('search_media', { keyword: '测试' })
  assert.ok(found.total >= 1)
  assert.equal(found.items.some((item) => item.mediaId === created.mediaId), true)
  assert.equal(found.truncated, false)

  const updated = await details('update_media', { mediaId: created.mediaId, title: '改名作品', season: 3 })
  assert.equal(updated.title, '改名作品')
  const storedAfter = models.media.find({ id: created.mediaId })
  assert.equal(storedAfter.season, 3)
  assert.equal(storedAfter.episodeCount, 12, '未提供的字段保持不变')

  await assert.rejects(run('create_media', {}), { status: 400 })
  await assert.rejects(run('create_media', { title: 'x', season: 'bad' }), { status: 400 })
  await assert.rejects(run('create_media', { title: 'x'.repeat(501) }), { status: 400 })
  await assert.rejects(run('update_media', { mediaId: created.mediaId }), { status: 400 })
  await assert.rejects(run('update_media', { mediaId: 999999, title: 'x' }), { status: 404 })
  await assert.rejects(run('search_media', { keyword: '   ' }), { status: 400 })
  await assert.rejects(run('search_media', { keyword: 'x'.repeat(240) }), { status: 400 })
  await assert.rejects(run('search_media', { keyword: '测试', limit: 500 }), { status: 400 })
})

test('get_media 返回影视字段、绑定目录、视频（含 missing）与观看进度', async () => {
  const media = catalog.create({ title: '详情作品', mediaType: 'anime', season: 1, episodeCount: 2 })
  const binding = models.localMedia.create({
    libraryId: 'bangumi', folderName: 'Season 1', folderPath: 'Show A/Season 1',
    folderHash: 'hash-detail', mediaId: media.id,
  })
  models.videos.create({
    localMediaId: binding.id, mediaId: media.id, mediaPath: '01.mkv', title: '01.mkv',
    videoIndex: 1, sizeBytes: 11, mtimeMs: 1000, missing: false,
  })
  models.videos.create({
    localMediaId: binding.id, mediaId: media.id, mediaPath: '02.mkv', title: '02.mkv',
    videoIndex: 2, sizeBytes: 11, mtimeMs: 1000, missing: true,
  })
  models.tracks.save({
    mediaId: media.id, videoIndex: 1, positionMs: 60000, durationMs: 1440000,
    completed: false, watchedAt: Date.now(),
  })

  const detail = await details('get_media', { mediaId: media.id })
  assert.equal(detail.media.mediaId, media.id)
  assert.equal(detail.media.title, '详情作品')
  assert.equal(detail.media.season, 1)
  assert.equal(detail.media.needsReview, false)
  assert.equal(detail.localMedia.length, 1)
  assert.equal(detail.localMedia[0].localMediaId, binding.id)
  assert.equal(detail.localMedia[0].folderPath, 'Show A/Season 1')
  assert.deepEqual(detail.localMedia[0].videos.map((video) => [video.index, video.missing]), [[1, false], [2, true]])
  assert.equal(detail.progress.total, 1)
  assert.equal(detail.progress.items[0].videoIndex, 1)
  assert.equal(detail.progress.items[0].completed, false)

  const text = (await run('get_media', { mediaId: media.id })).content[0].text
  assert.equal(JSON.parse(text).media.title, '详情作品')

  await assert.rejects(run('get_media', { mediaId: 999999 }), { status: 404 })
  await assert.rejects(run('get_media', { mediaId: 0 }), { status: 400 })
})

test('目录工具限量返回并拒绝越界路径', async () => {
  const folders = await details('list_folder', {})
  assert.equal(folders.libraryId, 'bangumi')
  assert.equal(folders.total, 1)
  assert.equal(folders.truncated, false)
  assert.deepEqual(folders.items.map((item) => [item.name, item.kind, item.count]), [['Season 1', 'dir', 2]])

  const binding = await details('get_folder_binding', { path: 'Show A' })
  assert.equal(binding.bound, false)
  assert.equal(binding.path, 'Show A')

  await assert.rejects(run('get_folder_binding', { path: '../outside' }), { status: 400 })
  await assert.rejects(run('get_folder_binding', { path: 'C:/windows' }), { status: 400 })
  await assert.rejects(run('get_folder_binding', { path: '/abs/path' }), { status: 400 })

  const browsed = await details('browse_library', { keyword: 'show' })
  assert.equal(browsed.total, 1)
  assert.equal(browsed.items[0].name, 'Show A')
  assert.equal(browsed.truncated, false)
  assert.equal((await details('browse_library', { keyword: '不存在' })).total, 0)
  await assert.rejects(run('browse_library', { limit: 0 }), { status: 400 })

  const mediaList = await details('list_media', { limit: 2 })
  assert.ok(mediaList.total >= 1)
  assert.equal(mediaList.limit, 2)
  assert.ok(mediaList.items.length <= 2)
  const firstPage = await details('list_media', { limit: 1 })
  if (firstPage.total > 1) assert.equal(firstPage.truncated, true)
})

test('任务工具：get_task / list_tasks / cancel_task 操作真实任务服务', async () => {
  const queued = task.create({ type: 'scan_library', payload: { libraryId: 'bangumi', maxDepth: 3 } })
  const got = await details('get_task', { id: queued.id })
  assert.equal(got.taskId, queued.id)
  assert.equal(got.type, 'scan_library')
  assert.equal(got.status, 'queued')
  assert.equal(got.payload.maxDepth, 3)
  assert.equal(JSON.parse((await run('get_task', { id: queued.id })).content[0].text).taskId, queued.id)

  const listed = await details('list_tasks', { status: 'queued' })
  assert.equal(listed.items.some((item) => item.taskId === queued.id), true)
  assert.equal(listed.truncated, false)

  const cancelled = await details('cancel_task', { id: queued.id })
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(models.task.find({ id: queued.id }).status, 'cancelled')

  await assert.rejects(run('get_task', { id: 999999 }), { status: 404 })
  await assert.rejects(run('get_task', { id: 0 }), { status: 400 })
  await assert.rejects(run('list_tasks', { status: 'nope' }), { status: 400 })
  await assert.rejects(run('list_tasks', { limit: 999 }), { status: 400 })
})

test('调度工具：list_scheduler_tasks / run_scheduler_task 异步触发', async () => {
  const schedulerTasks = await details('list_scheduler_tasks')
  assert.equal(schedulerTasks.timezone, 'Asia/Shanghai')
  assert.equal(schedulerTasks.total, 1)
  assert.equal(schedulerTasks.items[0].type, 'scan_library')
  assert.equal(schedulerTasks.items[0].options.maxDepth, 3)

  const triggered = await details('run_scheduler_task', { type: 'scan_library' })
  assert.equal(triggered.taskId, 88)
  assert.equal(triggered.async, true)
  assert.deepEqual(schedulerRuns.at(-1), { type: 'scan_library', options: { wait: false } })

  schedulerSkipped = true
  await assert.rejects(run('run_scheduler_task', { type: 'scan_library' }), { status: 409 })
  schedulerSkipped = false

  await assert.rejects(run('run_scheduler_task', { type: 'unknown' }), { status: 404 })
  await assert.rejects(run('run_scheduler_task', { type: '  ' }), { status: 400 })
})

test('扫描与归档工具走真实服务入口并返回 taskId', async () => {
  const media = catalog.create({ title: '归档作品', mediaType: 'anime' })
  const synced = await details('sync_local_media', { path: 'Show A/Season 1', mediaId: media.id })
  assert.equal(synced.localMediaId, 7)
  assert.equal(synced.mediaId, media.id)
  assert.equal(synced.total, 2)

  await assert.rejects(run('sync_local_media', { path: '', mediaId: media.id }), { status: 400 })
  await assert.rejects(run('sync_local_media', { path: 'Show A', mediaId: 999999 }), { status: 404 })
  await assert.rejects(run('sync_local_media', { path: '../x', mediaId: media.id }), { status: 400 })

  const scan = await details('scan_library', { maxDepth: 3 })
  assert.equal(scan.taskId, 42)
  assert.equal(scan.async, true)
  assert.equal(scan.libraryId, 'bangumi')
  await assert.rejects(run('scan_library', { maxDepth: 11 }), { status: 400 })

  const crawled = await details('crawl_bangumi', { subjectId: '400602' })
  assert.equal(crawled.created, true)
  assert.equal(typeof crawled.mediaId, 'number')
  assert.equal(crawled.jsonPath, 'bangumi/400602/subject.json')
  await assert.rejects(run('crawl_bangumi', { subjectId: 'abc' }), { status: 400 })
  await assert.rejects(run('crawl_bangumi', { subjectId: '0' }), { status: 400 })
})

test('search_bangumi / list_watch_progress / get_status 使用注入服务', async () => {
  const bangumi = await details('search_bangumi', { keyword: '芙莉莲', year: 2023 })
  assert.equal(bangumi.items[0].sourceId, '400602')
  assert.equal(bangumi.items[0].mediaType, 'anime')
  await assert.rejects(run('search_bangumi', { keyword: ' ' }), { status: 400 })
  await assert.rejects(run('search_bangumi', { keyword: 'x', year: 23 }), { status: 400 })

  const progress = await details('list_watch_progress')
  assert.equal(progress.total, 1)
  assert.equal(progress.items[0].percent, 25)
  assert.equal(progress.items[0].seriesTitle, 'Show A')

  const status = await details('get_status')
  assert.equal(status.ok, true)
  assert.equal(status.version, '0.1.0')
  assert.equal(status.libraries[0].id, 'bangumi')
  assert.equal(status.ffmpeg.transcode.encoder, 'libx264')

  await database.close()
})
