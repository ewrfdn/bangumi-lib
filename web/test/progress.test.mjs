import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getProgress, saveProgress, deleteProgress } from '../src/progress.js'

let storage
let records
let imported
let offline
const keyOf = (record) => JSON.stringify([record.libraryId || 'anime', record.path])
const episode = (libraryId, time) => ({ libraryId, path: '/Show/01.mp4', title: '第 1 集', time, duration: 100, at: Date.now() - 1000 })

beforeEach(() => {
  storage = new Map()
  records = new Map()
  imported = []
  offline = false
  globalThis.localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }
  globalThis.fetch = async (url, options = {}) => {
    if (offline) throw new Error('offline')
    const parsed = new URL(url, 'http://localhost')
    const body = options.body ? JSON.parse(options.body) : null
    let response
    if (parsed.pathname === '/api/progress/import') {
      imported.push(...body.items)
      for (const item of body.items) records.set(keyOf(item), { ...item, libraryId: item.libraryId || 'anime' })
      response = { items: [...records.values()] }
    } else if (options.method === 'PUT') {
      records.set(keyOf(body), body)
      response = { item: body }
    } else if (options.method === 'DELETE') {
      const key = keyOf({ libraryId: parsed.searchParams.get('library'), path: parsed.searchParams.get('path') })
      if (!records.has(key)) return new Response(JSON.stringify({ error: '媒体库或记录不存在' }), { status: 404 })
      records.delete(key)
      response = { ok: true }
    } else response = { items: [...records.values()] }
    return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
  }
})

test('same virtual video path in two libraries has independent offline progress and filtering', async () => {
  await getProgress()
  offline = true
  await saveProgress(episode('anime', 18))
  await saveProgress(episode('films', 65))
  assert.equal((await getProgress('anime'))[0].time, 18)
  assert.equal((await getProgress('films'))[0].time, 65)
  offline = false
  const items = await getProgress()
  assert.equal(items.length, 2)
  assert.equal(imported.length, 2)
  assert.equal(records.get(keyOf(episode('anime'))).time, 18)
  assert.equal(records.get(keyOf(episode('films'))).time, 65)
})

test('legacy local history migrates once and cached history cannot resurrect a remote deletion', async () => {
  const old = episode(undefined, 25)
  storage.set('anishare.progress', JSON.stringify({ [old.path]: old }))
  assert.equal((await getProgress())[0].libraryId, 'anime')
  assert.equal(imported.length, 1)
  records.clear() // Simulate deletion from another device.
  assert.deepEqual(await getProgress(), [])
  assert.equal(imported.length, 1)
})

test('deleting one library history entry preserves the other and clears its local pending copy', async () => {
  await getProgress()
  await saveProgress(episode('anime', 18))
  await saveProgress(episode('films', 65))
  await deleteProgress(episode('anime', 18))
  const items = await getProgress()
  assert.deepEqual(items.map((item) => item.libraryId), ['films'])
  assert.equal(imported.length, 0)
})

test('offline-only history for a removed library can be deleted when the server has no record', async () => {
  await getProgress()
  offline = true
  const record = episode('removed', 25)
  await saveProgress(record)
  offline = false
  await deleteProgress(record)
  assert.deepEqual(await getProgress(), [])
  assert.equal(imported.length, 0)
})
