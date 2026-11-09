import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-test-'))
const media = path.join(temporary, 'media')
await fs.mkdir(media)
await fs.writeFile(path.join(media, 'episode.mp4'), '0123456789')
// Never load the developer's private .env or probe real media in these tests.
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.BANGUMI_ROOT = media
delete process.env.MEDIA_LIBRARIES
process.env.DATA_DIR = path.join(temporary, 'data')
const { createApp } = await import('../src/app.ts')
const { createSession, stopAllSessions } = await import('../src/service/hls.service.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))

let counter = 0
async function makeApp(options = {}) {
  const app = await createApp({
    logger: false,
    dbPath: path.join(temporary, `${counter++}.sqlite`),
    authSecret: 'test-access-key',
    sessionDays: 30,
    secureCookies: false,
    ...options,
  })
  await app.ready()
  return app
}

async function login(app, extra = {}) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'test-access-key' }, ...extra })
  assert.equal(response.statusCode, 200)
  const cookie = response.headers['set-cookie']
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.doesNotMatch(cookie, /test-access-key/)
  return cookie.split(';')[0]
}

test('all media and library API routes require authentication, including HEAD', async () => {
  const app = await makeApp()
  try {
    const routes = [
      ['GET', '/api/status'], ['GET', '/api/library'], ['GET', '/api/list?path=/'],
      ['GET', '/api/video?path=/episode.mp4'], ['GET', '/api/stream?path=/episode.mp4'],
      ['HEAD', '/api/stream?path=/episode.mp4'], ['GET', '/api/file?path=/episode.mp4'],
      ['GET', '/api/subtitle?path=/subtitle.srt'], ['GET', '/api/stream-subtitle?path=/episode.mp4&index=0'],
      ['GET', '/api/hls/start?path=/episode.mp4'], ['GET', '/api/hls/fake/index.m3u8'],
      ['GET', '/api/hls/fake/seg/test.ts'], ['GET', '/api/hls/fake/info'],
      ['DELETE', '/api/hls/fake'], ['GET', '/api/progress'], ['PUT', '/api/progress'],
      ['POST', '/api/progress/import'],
    ]
    for (const [method, url] of routes) {
      const response = await app.inject({ method, url })
      assert.equal(response.statusCode, 401, `${method} ${url}`)
    }
    const session = await app.inject('/api/auth/session')
    assert.deepEqual(session.json(), { enabled: true, authenticated: false })
    assert.equal(session.headers['cache-control'], 'no-store')
  } finally { await app.close() }
})

test('key login, cookie Range playback, logout and cross-origin rejection', async () => {
  const app = await makeApp()
  try {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'wrong' } })
    assert.equal(bad.statusCode, 401)
    const cookie = await login(app, { headers: { origin: 'http://localhost:5173', host: 'localhost:5173' } })
    const session = await app.inject({ url: '/api/auth/session', headers: { cookie } })
    assert.deepEqual(session.json(), { enabled: true, authenticated: true })
    const stream = await app.inject({ url: '/api/stream?path=/episode.mp4', headers: { cookie, range: 'bytes=2-5' } })
    assert.equal(stream.statusCode, 206)
    assert.equal(stream.body, '2345')
    const poster = await app.inject({ url: '/api/file?path=/episode.mp4', headers: { cookie } })
    assert.doesNotMatch(poster.headers['cache-control'], /public/)
    const csrf = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: 'https://evil.example' } })
    assert.equal(csrf.statusCode, 403)
    const fetchCsrf = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'sec-fetch-site': 'cross-site' }, payload: { key: 'test-access-key' } })
    assert.equal(fetchCsrf.statusCode, 403)
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    assert.equal(logout.statusCode, 200)
    assert.match(logout.headers['set-cookie'], /Max-Age=0/)
    assert.equal((await app.inject({ url: '/api/list?path=/', headers: { cookie } })).statusCode, 401)
  } finally { await app.close() }
})

test('absolute-form HTTP request targets cannot bypass API authentication', async () => {
  const app = await makeApp()
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = app.server.address().port
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port,
        path: `http://127.0.0.1:${port}/api/library`,
      }, (result) => {
        let body = ''
        result.on('data', (chunk) => { body += chunk })
        result.on('end', () => resolve({ statusCode: result.statusCode, body }))
      })
      request.on('error', reject)
      request.end()
    })
    assert.equal(response.statusCode, 401)
    assert.match(JSON.parse(response.body).error, /登录/)
  } finally { await app.close() }
})

test('HLS status exposes the real session timeline even when probe metadata is present', async () => {
  const app = await makeApp()
  try {
    const cookie = await login(app)
    const session = createSession('status-regression', path.join(media, 'episode.mp4'), 30, {
      duration: 1400, bitrate: 2_000_000, video: { codec: 'hevc' },
    })
    session.encoder = 'libx264'
    const getStatus = () => app.inject({ url: '/api/hls/status-regression/info', headers: { cookie } })
    const initial = await getStatus()
    assert.equal(initial.statusCode, 200)
    assert.deepEqual(initial.json(), {
      id: 'status-regression', start: 30, firstStart: 0, frontier: 30,
      ended: false, error: null, encoder: 'libx264',
    })
    session.segments.push({ name: 'seg-00000.ts', start: 0, duration: 5 }, { name: 'seg-00001.ts', start: 5, duration: 5 })
    session.ended = true
    const completed = await getStatus()
    assert.equal(completed.statusCode, 200)
    assert.equal(completed.headers['cache-control'], 'no-store')
    assert.deepEqual(completed.json(), {
      id: 'status-regression', start: 30, firstStart: 30, frontier: 40,
      ended: true, error: null, encoder: 'libx264',
    })
  } finally {
    stopAllSessions()
    await app.close()
  }
})

test('sessions survive restart, expire in SQLite, and are revoked when key changes', async () => {
  const dbPath = path.join(temporary, 'persistent.sqlite')
  let app = await makeApp({ dbPath })
  const cookie = await login(app)
  await app.close()
  app = await makeApp({ dbPath })
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie } })).json().authenticated, true)
  await app.close()
  app = await makeApp({ dbPath, authSecret: 'rotated-key' })
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie } })).json().authenticated, false)
  await app.close()
  app = await makeApp({ dbPath, sessionDays: -1 })
  const expiredCookie = await login(app)
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie: expiredCookie } })).json().authenticated, false)
  await app.close()
})

test('invalid keys are throttled and HTTPS deployment can force Secure cookies', async () => {
  const app = await makeApp({ secureCookies: true })
  try {
    const cookie = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'test-access-key' } })
    assert.match(cookie.headers['set-cookie'], /; Secure/)
    for (let i = 0; i < 10; i++) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'wrong' } })).statusCode, 401)
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'test-access-key' } })
    assert.equal(blocked.statusCode, 429)
    assert.ok(Number(blocked.headers['retry-after']) > 0)
  } finally { await app.close() }
})

test('progress persists in SQLite, supports migration without overwriting newer records, and validates batches', async () => {
  const dbPath = path.join(temporary, 'progress.sqlite')
  let app = await makeApp({ dbPath, authSecret: '' })
  const item = { path: '/episode.mp4', title: '第一集', time: 120, duration: 1400, at: Date.now() - 1000, hevc: true }
  const save = await app.inject({ method: 'PUT', url: '/api/progress', payload: item })
  assert.equal(save.statusCode, 200)
  assert.equal(save.json().item.time, 120)
  await app.close()
  app = await makeApp({ dbPath, authSecret: '' })
  try {
    const list = await app.inject('/api/progress')
    assert.equal(list.json().items[0].title, '第一集')
    assert.equal(list.headers['cache-control'], 'no-store')
    const imported = await app.inject({ method: 'POST', url: '/api/progress/import', payload: { items: [
      { ...item, time: 10, at: item.at - 10000 },
      { ...item, path: '/episode-2.mp4', title: '第二集' },
    ] } })
    assert.equal(imported.statusCode, 200)
    assert.equal(imported.json().items.find((entry) => entry.path === item.path).time, 120)
    assert.equal(imported.json().items.length, 2)
    for (const payload of [
      { ...item, path: 'relative.mp4' }, { ...item, time: -1 }, { ...item, duration: 0 },
      { ...item, time: '12' }, { ...item, at: -1 }, { ...item, title: 123 },
    ]) {
      assert.equal((await app.inject({ method: 'PUT', url: '/api/progress', payload })).statusCode, 400)
    }
    const invalidBatch = await app.inject({ method: 'POST', url: '/api/progress/import', payload: { items: [
      { ...item, path: '/should-not-exist.mp4' }, { ...item, duration: -5 },
    ] } })
    assert.equal(invalidBatch.statusCode, 400)
    assert.equal((await app.inject('/api/progress')).json().items.length, 2)
    const cleared = await app.inject({ method: 'DELETE', url: '/api/progress?path=/episode-2.mp4' })
    assert.equal(cleared.statusCode, 200)
    assert.equal((await app.inject('/api/progress')).json().items.length, 1)
    assert.deepEqual((await app.inject('/api/auth/session')).json(), { enabled: false, authenticated: true })
    assert.deepEqual((await app.inject({ method: 'POST', url: '/api/auth/logout' })).json(), { enabled: false, authenticated: true })
  } finally { await app.close() }
})

test('authenticated history deletion removes retired-library records without touching another library', async () => {
  const app = await makeApp()
  try {
    const cookie = await login(app)
    const record = { path: '/unavailable/episode.mp4', title: 'Episode', time: 120, duration: 1400, at: Date.now(), hevc: false }
    app.database.writeProgress({ ...record, libraryId: 'retired' })
    app.database.writeProgress({ ...record, libraryId: 'bangumi', time: 400 })
    const removed = await app.inject({ method: 'DELETE', url: '/api/progress?library=retired&path=/unavailable/episode.mp4', headers: { cookie } })
    assert.equal(removed.statusCode, 200)
    assert.equal(app.database.getProgress(record.path, 'retired'), null)
    assert.equal(app.database.getProgress(record.path, 'bangumi').time, 400)
    const unknown = await app.inject({ method: 'DELETE', url: '/api/progress?library=retired&path=/unavailable/episode.mp4', headers: { cookie } })
    assert.equal(unknown.statusCode, 404)
    const knownMissing = await app.inject({ method: 'DELETE', url: '/api/progress?library=bangumi&path=/missing/episode.mp4', headers: { cookie } })
    assert.equal(knownMissing.statusCode, 200)
    const outside = path.join(temporary, 'outside-history')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(media, 'blocked-history'), 'junction')
    app.database.writeProgress({ ...record, libraryId: 'bangumi', path: '/blocked-history/episode.mp4' })
    const inaccessible = await app.inject({ method: 'DELETE', url: '/api/progress?library=bangumi&path=/blocked-history/episode.mp4', headers: { cookie } })
    assert.equal(inaccessible.statusCode, 200)
    assert.equal(app.database.getProgress('/blocked-history/episode.mp4', 'bangumi'), null)
  } finally { await app.close() }
})
