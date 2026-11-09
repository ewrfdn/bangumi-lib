import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-catalog-api-'))
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.BANGUMI_ROOT = temporary
process.env.DATA_DIR = path.join(temporary, 'data')
delete process.env.MEDIA_LIBRARIES
const { createApp } = await import('../src/app.ts')
const { createDatabase } = await import('../src/model/database.ts')
after(() => {
  const target = path.resolve(temporary)
  assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('anishare-catalog-api-'))
  return fs.rm(target, { recursive: true, force: true })
})
const application = options => createApp({ logger: false, dbPath: ':memory:', authSecret: '', ...options })

async function request(app, method, url, payload, status = 200, headers) {
  const response = await app.inject({ method, url, payload, headers })
  assert.equal(response.statusCode, status, response.body)
  return response.json()
}
async function seed(app) {
  const media = (await request(app, 'POST', '/api/media', { title: '测试番剧', episodeCount: 12, tags: ['科幻'], attribute: { sourceId: '123' } }, 201)).item
  const folder = (await request(app, 'POST', '/api/local-media', { mediaId: media.id, folderPath: '测试番剧' }, 201)).item
  const video = (await request(app, 'POST', '/api/local-media-videos', { localMediaId: folder.id, mediaPath: '第01集.mkv', videoIndex: 1, durationMs: 120000 }, 201)).item
  return { media, folder, video }
}

test('v3 upgrades to v6 without changing legacy history, sessions or encrypted settings; catalog survives restart', async () => {
  const filename = path.join(temporary, 'upgrade.sqlite')
  // An actual v3 schema, independent of the new createDatabase migration code.
  const old = new Database(filename)
  old.exec(`CREATE TABLE playback_progress (library_id TEXT NOT NULL,path TEXT NOT NULL,title TEXT NOT NULL,time REAL NOT NULL,duration REAL NOT NULL,at INTEGER NOT NULL,hevc INTEGER NOT NULL DEFAULT 0,poster TEXT,series_path TEXT,series_title TEXT,PRIMARY KEY(library_id,path));
    CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE app_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO playback_progress(library_id,path,title,time,duration,at) VALUES('default','/missing.mp4','Old',12,100,1000);
    INSERT INTO auth_sessions VALUES('token','secret',9999999999999);
    INSERT INTO app_settings VALUES('ai-config','encrypted-old-value',1);
    PRAGMA user_version=3;`)
  old.close()
  const migrated = createDatabase(filename)
  try {
    assert.equal(migrated.info().schemaVersion, 6)
    assert.ok(migrated.findSession('token', 'secret', 1))
    assert.equal(migrated.getSetting('ai-config').value, 'encrypted-old-value')
  } finally { migrated.close() }
  let app = await application({ dbPath: filename })
  let media
  try {
    assert.equal(app.database.info().schemaVersion, 6)
    assert.equal(app.database.getProgress('/missing.mp4').time, 12)
    assert.equal(app.database.getSetting('ai-config').value, 'encrypted-old-value')
    // Avoid loading the deliberately opaque old AI value through the AI service.
    media = (await request(app, 'POST', '/api/media', { title: '持久化番剧' }, 201)).item
  } finally { await app.close() }
  app = await application({ dbPath: filename })
  try {
    assert.equal((await request(app, 'GET', `/api/media/${media.id}`)).item.title, '持久化番剧')
    assert.equal(app.database.info().progressCount, 1)
  } finally { await app.close() }
  const check = new Database(filename, { readonly: true })
  try {
    assert.equal(check.pragma('user_version', { simple: true }), 6)
    assert.equal(check.pragma('foreign_key_check').length, 0)
    assert.deepEqual(check.pragma('table_info(media_tracks)').filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name), ['media_id', 'video_index'])
  } finally { check.close() }
})

test('a newer database version is refused without downgrading or modifying its schema', () => {
  const filename = path.join(temporary, 'future.sqlite')
  const future = new Database(filename)
  future.pragma('user_version=99')
  future.close()
  assert.throws(() => createDatabase(filename), /版本/)
  const check = new Database(filename)
  try {
    assert.equal(check.pragma('user_version', { simple: true }), 99)
    assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n, 0)
  } finally { check.close() }
})

test('v4 adds nullable source fields without losing existing media and preserves sources across restart', async () => {
  const filename = path.join(temporary, 'v4-source.sqlite')
  const old = new Database(filename)
  old.exec(await fs.readFile(new URL('../db/migrations/004_catalog.sql', import.meta.url), 'utf8'))
  old.exec(`
    CREATE TABLE playback_progress (library_id TEXT NOT NULL,path TEXT NOT NULL,title TEXT NOT NULL,time REAL NOT NULL,duration REAL NOT NULL,at INTEGER NOT NULL,hevc INTEGER NOT NULL DEFAULT 0,poster TEXT,series_path TEXT,series_title TEXT,PRIMARY KEY(library_id,path));
    CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE app_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO media(id,title,season,episode_count,created_at,updated_at) VALUES(1,'已有影视',2,12,1,1);
    PRAGMA user_version=4;
  `)
  old.close()
  let app = await application({ dbPath: filename })
  try {
    const initial = (await request(app, 'GET', '/api/media/1')).item
    assert.equal(initial.title, '已有影视')
    assert.equal(initial.dataSource, null)
    assert.equal(initial.dataSourceUrl, null)
    await request(app, 'PATCH', '/api/media/1', { dataSource: 'Bangumi', dataSourceUrl: 'https://bgm.tv/subject/123' })
    for (const dataSourceUrl of ['javascript:alert(1)', 'file:///private', 'not-a-url', 'https://user:secret@example.com/']) {
      await request(app, 'PATCH', '/api/media/1', { dataSourceUrl }, 400)
    }
  } finally { await app.close() }
  app = await application({ dbPath: filename })
  try {
    const saved = (await request(app, 'GET', '/api/media/1')).item
    assert.equal(saved.dataSource, 'Bangumi')
    assert.equal(saved.dataSourceUrl, 'https://bgm.tv/subject/123')
    assert.equal(saved.season, 2)
    const cleared = (await request(app, 'PATCH', '/api/media/1', { dataSource: null, dataSourceUrl: null })).item
    assert.equal(cleared.dataSource, null)
    assert.equal(cleared.dataSourceUrl, null)
    const created = (await request(app, 'POST', '/api/media', { title: '新影视', dataSource: 'TMDB', dataSourceUrl: 'https://www.themoviedb.org/movie/123' }, 201)).item
    assert.equal(created.dataSource, 'TMDB')
    assert.equal(app.database.info().schemaVersion, 6)
  } finally { await app.close() }
})

test('metadata, local folders and video CRUD round-trip JSON and preserve association constraints', async () => {
  const app = await application()
  try {
    const { media, folder, video } = await seed(app)
    assert.deepEqual(media.tags, ['科幻'])
    assert.deepEqual(media.attribute, { sourceId: '123' })
    assert.equal(media.season, 1)
    assert.equal('durationMs' in media, false)
    assert.equal(folder.folderName, '测试番剧')
    assert.match(folder.folderHash, /^[a-f0-9]{64}$/)
    assert.equal(video.mediaId, media.id)
    assert.equal(video.missing, false)
    const edited = (await request(app, 'PATCH', `/api/media/${media.id}`, { season: 2, rating: 9.5, airedOn: '2026-10-01', tags: ['科幻', '科幻'] })).item
    assert.equal(edited.season, 2)
    assert.deepEqual(edited.tags, ['科幻'])
    assert.equal((await request(app, 'GET', '/api/media?q=测试&limit=1')).total, 1)
    assert.equal((await request(app, 'GET', `/api/local-media?mediaId=${media.id}`)).total, 1)
    assert.equal((await request(app, 'GET', `/api/local-media-videos?localMediaId=${folder.id}`)).total, 1)
    await request(app, 'POST', '/api/local-media', { mediaId: media.id, folderPath: '测试番剧/' }, 409)
    await request(app, 'DELETE', `/api/media/${media.id}`, undefined, 409)
    await request(app, 'DELETE', `/api/local-media/${folder.id}`, undefined, 409)
    const second = (await request(app, 'POST', '/api/media', { title: '其他番剧' }, 201)).item
    await request(app, 'PATCH', `/api/local-media-videos/${video.id}`, { mediaId: second.id }, 400)
    await request(app, 'PATCH', `/api/local-media/${folder.id}`, { mediaId: second.id }, 409)
    await request(app, 'DELETE', `/api/local-media-videos/${video.id}`)
    await request(app, 'DELETE', `/api/local-media/${folder.id}`)
    await request(app, 'DELETE', `/api/media/${media.id}`)
    await request(app, 'GET', `/api/media/${media.id}`, undefined, 404)
  } finally { await app.close() }
})

test('relative paths, integer season/count, query bounds and unsupported fields reject bad input', async () => {
  const app = await application()
  try {
    const { media, folder } = await seed(app)
    for (const patch of [{ season: 1.5 }, { episodeCount: -1 }, { episodeCount: 12.5 }, { durationMs: 1 }, { tags: {} }, { rating: 11 }, { airedOn: '2026-02-30' }, { attribute: [] }]) {
      await request(app, 'PATCH', `/api/media/${media.id}`, patch, 400)
    }
    for (const folderPath of ['../outside', 'A:/outside', '/absolute', 'ok/../../outside']) {
      await request(app, 'POST', '/api/local-media', { mediaId: media.id, folderPath }, 400)
    }
    await request(app, 'POST', '/api/local-media', { mediaId: media.id, folderPath: 'another', libraryId: 'unknown' }, 404)
    await request(app, 'POST', '/api/local-media-videos', { localMediaId: folder.id, mediaPath: '../x.mp4', videoIndex: 2 }, 400)
    await request(app, 'GET', '/api/media?limit=201', undefined, 400)
    await request(app, 'GET', '/api/media?offset=-1', undefined, 400)
    await request(app, 'GET', '/api/media?sort=title', undefined, 400)
    await request(app, 'GET', '/api/media/not-an-id', undefined, 400)
    assert.equal((await request(app, 'GET', '/api/media?q=%27%20OR%201%3D1--')).total, 0)
  } finally { await app.close() }
})

test('history uses mediaId + videoIndex across versions, rejects stale writes and retains missing-file history', async () => {
  const app = await application()
  try {
    const { media, folder, video } = await seed(app)
    await request(app, 'POST', '/api/local-media-videos', { localMediaId: folder.id, mediaPath: '01-4K.mkv', videoIndex: 1 }, 201)
    const url = `/api/media-tracks/${media.id}/1`, firstAt = Date.now() - 1000
    const first = (await request(app, 'PUT', url, { positionMs: 1000, durationMs: 120000, watchedAt: firstAt })).item
    assert.equal('videoId' in first, false)
    assert.equal('id' in first, false)
    await request(app, 'PUT', url, { positionMs: 5000, durationMs: 120000, watchedAt: firstAt + 1 })
    const stale = (await request(app, 'PUT', url, { positionMs: 0, watchedAt: firstAt - 1 })).item
    assert.equal(stale.positionMs, 5000)
    assert.equal((await request(app, 'GET', `/api/media-tracks?mediaId=${media.id}`)).total, 1)
    await request(app, 'PUT', url, { positionMs: 120001, durationMs: 120000 }, 400)
    await request(app, 'PUT', `/api/media-tracks/${media.id}/99`, { positionMs: 0 }, 404)
    await request(app, 'PUT', url, { positionMs: 0, videoId: video.id }, 400)
    await request(app, 'PATCH', `/api/local-media-videos/${video.id}`, { missing: true })
    await request(app, 'DELETE', `/api/local-media-videos/${video.id}`)
    const response = await app.inject(url)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.json().item.positionMs, 5000)
    await request(app, 'DELETE', url)
    await request(app, 'GET', url, undefined, 404)
  } finally { await app.close() }
})

test('generic tasks queue, claim atomically, advance and finish; terminal and cancelled tasks cannot restart', async () => {
  const app = await application()
  try {
    const task = (await request(app, 'POST', '/api/tasks', { type: 'download_video', payload: { mediaId: 42, source: 'local-test' } }, 201)).item
    assert.equal(task.status, 'queued')
    assert.deepEqual(task.payload, { mediaId: 42, source: 'local-test' })
    await request(app, 'DELETE', `/api/tasks/${task.id}`, undefined, 409)
    const future = (await request(app, 'POST', '/api/tasks', { type: 'scan_library', runAfter: Date.now() + 600000 }, 201)).item
    assert.equal(app.services.task.claimNext().id, task.id)
    assert.equal(app.services.task.claimNext(), null)
    assert.equal(app.services.task.progress(task.id, 50).progress, 50)
    const done = app.services.task.complete(task.id, { imported: 1 })
    assert.equal(done.progress, 100)
    assert.deepEqual(done.result, { imported: 1 })
    assert.throws(() => app.services.task.fail(task.id, 'late failure'), { statusCode: 409 })
    await request(app, 'POST', `/api/tasks/${task.id}/cancel`, {}, 409)
    await request(app, 'POST', `/api/tasks/${future.id}/cancel`, {})
    assert.equal(app.services.task.claimNext(), null)
    await request(app, 'DELETE', `/api/tasks/${future.id}`)
    assert.equal((await request(app, 'GET', '/api/tasks?type=download_video&status=succeeded')).total, 1)
    await request(app, 'POST', '/api/tasks', { type: 'x', status: 'running' }, 400)
  } finally { await app.close() }
})

test('catalog controllers share configured key login and cross-origin mutation protection', async () => {
  const app = await application({ authSecret: 'catalog-key' })
  try {
    for (const url of ['/api/media', '/api/local-media', '/api/local-media-videos', '/api/media-tracks', '/api/tasks']) {
      await request(app, 'GET', url, undefined, 401)
      await request(app, 'POST', url, {}, 401)
    }
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'catalog-key' } })
    const headers = { cookie: login.headers['set-cookie'].split(';')[0] }
    await request(app, 'POST', '/api/media', { title: '授权条目' }, 201, headers)
    await request(app, 'POST', '/api/media', { title: '拒绝条目' }, 403, { ...headers, origin: 'https://untrusted.example' })
    assert.equal((await request(app, 'GET', '/api/media', undefined, 200, headers)).total, 1)
  } finally { await app.close() }
})
