import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-scan-api-'))
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.DATA_DIR = path.join(temporary, 'data')
process.env.BANGUMI_LIBRARY = path.join(temporary, 'library')
process.env.TASKS_CONFIG = path.join(temporary, 'tasks.yaml')

const libraryRoot = path.join(temporary, 'library')
await fs.mkdir(path.join(libraryRoot, 'Show A', 'Season 1'), { recursive: true })
await fs.writeFile(path.join(libraryRoot, 'Show A', 'Season 1', '01.mkv'), 'episode')
await fs.writeFile(path.join(libraryRoot, 'Show A', 'Season 1', '01.ass'), 'subtitle')
await fs.writeFile(path.join(temporary, 'tasks.yaml'), 'tasks:\n  - type: scan_library\n    cron: "0 0 * * * *"\n    options:\n      libraryId: bangumi\n')

const { createApp } = await import('../src/app.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))

const makeApp = async () => {
  const app = await createApp({ dbPath: ':memory:', logger: false, authSecret: '' })
  await app.ready()
  return app
}

async function waitForTask(app, id, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const task = (await app.inject(`/api/tasks/${id}`)).json().item
    if (task.status !== 'running' && task.status !== 'queued') return task
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('任务未在限定时间内结束')
}

test('a manual scan returns a task id and records the tree', async () => {
  const app = await makeApp()
  try {
    const empty = (await app.inject('/api/lib-folders')).json()
    assert.equal(empty.libraryId, 'bangumi')
    assert.equal(empty.libraryName, '番剧库')
    assert.deepEqual(empty.items, [])
    assert.deepEqual(empty.stats, {})

    const started = await app.inject({ method: 'POST', url: '/api/libraries/bangumi/scan', payload: { maxDepth: 3 } })
    assert.equal(started.statusCode, 202)
    const { taskId } = started.json()
    assert.ok(taskId)

    const task = await waitForTask(app, taskId)
    assert.equal(task.type, 'scan_library')
    assert.equal(task.status, 'succeeded')
    assert.deepEqual(task.payload, { libraryId: 'bangumi', maxDepth: 3 })
    assert.ok(task.result.visited >= 3)

    const tree = (await app.inject('/api/lib-folders?includeMissing=1')).json()
    assert.deepEqual(tree.items.map((item) => item.relPath), ['', 'Show A', 'Show A/Season 1'])
    assert.equal(tree.items[1].parentId, tree.items[0].id)
    assert.equal(tree.items[2].depth, 2)
    // AI 未启用时，需要分类的目录记为 failed 并等待下次扫描。
    assert.equal(tree.stats.failed >= 1, true)
    assert.equal(tree.items.find((item) => item.relPath === 'Show A/Season 1').status, 'failed')

    // force=true 允许重试上一次没有成功分类的目录（忽略 mtime 缓存）。
    const forced = await app.inject({ method: 'POST', url: '/api/libraries/bangumi/scan', payload: { maxDepth: 3, force: true } })
    assert.equal(forced.statusCode, 202)
    assert.equal(forced.json().force, true)
    const forcedTask = await waitForTask(app, forced.json().taskId)
    assert.equal(forcedTask.status, 'succeeded')
    assert.equal(forcedTask.payload.force, true)
  } finally { await app.close() }
})

test('scan endpoints validate their input', async () => {
  const app = await makeApp()
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/libraries/nope/scan' })).statusCode, 404)
    assert.equal((await app.inject({ method: 'POST', url: '/api/libraries/bangumi/scan', payload: { maxDepth: 99 } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/api/libraries/bangumi/scan', payload: { depth: 2 } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/api/libraries/bangumi/scan', payload: { force: 'yes' } })).statusCode, 400)
    assert.equal((await app.inject('/api/lib-folders?library=nope')).statusCode, 404)
    assert.equal((await app.inject('/api/lib-folders?unexpected=1')).statusCode, 400)
  } finally { await app.close() }
})

test('the scheduler exposes its tasks and can trigger one by hand', async () => {
  const app = await makeApp()
  try {
    const listed = (await app.inject('/api/scheduler/tasks')).json()
    assert.equal(listed.timezone, 'Asia/Shanghai')
    assert.equal(listed.tasks.length, 1)
    assert.equal(listed.tasks[0].type, 'scan_library')
    assert.ok(listed.tasks[0].nextRun)
    assert.equal(listed.tasks[0].running, false)

    const missing = await app.inject({ method: 'POST', url: '/api/scheduler/tasks/nope/run' })
    assert.equal(missing.statusCode, 404)

    const triggered = await app.inject({ method: 'POST', url: '/api/scheduler/tasks/scan_library/run' })
    assert.equal(triggered.statusCode, 202)
    const { taskId, type } = triggered.json()
    assert.equal(type, 'scan_library')
    const task = await waitForTask(app, taskId)
    assert.equal(task.status, 'succeeded')
    assert.equal(task.type, 'scan_library')

    const reloaded = await app.inject({ method: 'POST', url: '/api/scheduler/reload' })
    assert.equal(reloaded.statusCode, 200)
    assert.equal(reloaded.json().ok, true)
  } finally { await app.close() }
})
