import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-lib-folder-'))
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.DATA_DIR = path.join(temporary, 'data')

const root = path.join(temporary, 'library')
await fs.mkdir(path.join(root, 'Show A', 'Season 1'), { recursive: true })
await fs.writeFile(path.join(root, 'Show A', 'Season 1', '01.mkv'), 'video')
await fs.writeFile(path.join(root, 'Show A', 'Season 1', '01.ass'), 'subtitle')
await fs.mkdir(path.join(root, 'Movie B'), { recursive: true })
await fs.writeFile(path.join(root, 'Movie B', 'film.mp4'), 'video')
await fs.writeFile(path.join(root, '.hidden'), 'ignored')
await fs.mkdir(path.join(root, '@eaDir'), { recursive: true })

const { createDatabase } = await import('../src/model/database.ts')
const { createLibFolderService } = await import('../src/service/lib-folder.service.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))

const database = createDatabase(':memory:')
const settings = {
  getLibrary(id) {
    if (id !== 'bangumi') { const error = new Error('媒体库不存在'); error.status = 404; throw error }
    return { id: 'bangumi', name: '番剧库', root }
  },
}
const service = createLibFolderService({ models: database, settings })

const collect = () => {
  const seen = []
  seen.onChanged = (payload) => seen.push(payload)
  return seen
}
const rowsByPath = () => Object.fromEntries(database.libFolder.list('bangumi').map((row) => [row.relPath, row]))

test('first scan records every directory and lists only visible direct children', async () => {
  const seen = collect()
  const summary = await service.scan('bangumi', { onChanged: seen.onChanged })

  assert.equal(summary.visited, 4)
  assert.equal(summary.changed, 4)
  assert.equal(summary.failed, 0)

  const rows = rowsByPath()
  assert.deepEqual(Object.keys(rows).sort(), ['', 'Movie B', 'Show A', 'Show A/Season 1'])

  const rootRow = rows['']
  assert.equal(rootRow.parentId, null)
  assert.equal(rootRow.depth, 0)
  assert.equal(rootRow.entryCount, 2)          // .hidden 与 @eaDir 被忽略
  assert.equal(rootRow.status, 'scanned')
  assert.ok(rootRow.scannedAt > 0)
  assert.equal(rows['Show A'].parentId, rootRow.id)
  assert.equal(rows['Show A/Season 1'].parentId, rows['Show A'].id)

  const season = seen.find((payload) => payload.folder.relPath === 'Show A/Season 1')
  assert.deepEqual(season.entries.items.map((item) => [item.name, item.kind, item.ext]), [
    ['01.ass', 'file', 'ass'], ['01.mkv', 'file', 'mkv'],
  ])
  assert.equal(season.entries.truncated, false)
  assert.equal(season.library.id, 'bangumi')
})

test('an unchanged tree triggers no callback but still refreshes scan time', async () => {
  const before = rowsByPath()[''].scannedAt
  await new Promise((resolve) => setTimeout(resolve, 5))
  const seen = collect()
  const summary = await service.scan('bangumi', { onChanged: seen.onChanged })

  assert.equal(summary.changed, 0)
  assert.equal(seen.length, 0)
  assert.ok(rowsByPath()[''].scannedAt > before)
})

test('adding an episode only re-examines its own directory', async () => {
  await fs.writeFile(path.join(root, 'Show A', 'Season 1', '02.mkv'), 'video')
  const seen = collect()
  const summary = await service.scan('bangumi', { onChanged: seen.onChanged })

  assert.equal(summary.changed, 1)
  assert.deepEqual(seen.map((payload) => payload.folder.relPath), ['Show A/Season 1'])
  assert.equal(rowsByPath()['Show A/Season 1'].entryCount, 3)
})

test('renaming inside a nested directory is still detected', async () => {
  await fs.rename(path.join(root, 'Show A', 'Season 1', '02.mkv'), path.join(root, 'Show A', 'Season 1', '02-renamed.mkv'))
  const seen = collect()
  await service.scan('bangumi', { onChanged: seen.onChanged })

  assert.deepEqual(seen.map((payload) => payload.folder.relPath), ['Show A/Season 1'])
})

test('a failing handler keeps the folder pending and retries on the next scan', async () => {
  await fs.mkdir(path.join(root, 'Broken'), { recursive: true })
  const failing = () => { throw new Error('agent 失败') }
  await service.scan('bangumi', { onChanged: failing })

  const failed = rowsByPath().Broken
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /agent 失败/)

  const seen = collect()
  await service.scan('bangumi', { onChanged: seen.onChanged })
  assert.ok(seen.some((payload) => payload.folder.relPath === 'Broken'))
  assert.equal(rowsByPath().Broken.status, 'scanned')
  assert.equal(rowsByPath().Broken.error, null)
})

test('removed directories are marked missing and stay recorded', async () => {
  await fs.rm(path.join(root, 'Movie B'), { recursive: true })
  await service.scan('bangumi', { onChanged: collect().onChanged })

  const rows = rowsByPath()
  assert.equal(rows['Movie B'].status, 'missing')
  assert.equal(rows[''].status, 'scanned')

  // 记录保留，但默认列表不再展示 missing 目录。
  assert.equal(service.list('bangumi').some((row) => row.relPath === 'Movie B'), false)
  assert.equal(service.list('bangumi', { includeMissing: true }).some((row) => row.relPath === 'Movie B'), true)
  assert.equal(service.list('bangumi').length, Object.keys(rows).length - 1)
})

test('depth limit stops the walk and invalid values are rejected', async () => {
  const shallow = Object.fromEntries(database.libFolder.list('bangumi').map((row) => [row.relPath, row]))
  assert.ok(shallow['Show A/Season 1'])

  const fresh = createDatabase(':memory:')
  const limited = createLibFolderService({ models: fresh, settings })
  const summary = await limited.scan('bangumi', { maxDepth: 0 })
  assert.equal(summary.visited, 1)
  assert.deepEqual(fresh.libFolder.list('bangumi').map((row) => row.relPath), [''])

  for (const maxDepth of [-1, 11, 1.5, '2']) {
    await assert.rejects(() => service.scan('bangumi', { maxDepth }), { status: 400 })
  }
})

test('unknown libraries are rejected before touching the filesystem', async () => {
  await assert.rejects(() => service.scan('unknown'), { status: 404 })
})
