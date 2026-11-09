import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-scheduler-'))
process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.DATA_DIR = path.join(temporary, 'data')
process.env.BANGUMI_LIBRARY = path.join(temporary, 'library')
await fs.mkdir(path.join(temporary, 'library'), { recursive: true })

const { BaseTask } = await import('../src/scheduler/base.task.ts')
const { createTaskRegistry } = await import('../src/scheduler/registry.ts')
const { createSchedulerManager } = await import('../src/scheduler/manager.ts')
const { parseTaskConfig } = await import('../src/scheduler/task-config.ts')
const { createDatabase } = await import('../src/model/database.ts')
after(() => fs.rm(temporary, { recursive: true, force: true }))

class PingTask extends BaseTask {
  static type = 'ping'
  static cron = '0 0 * * * *'
  static timeoutMs = 5000
  validate(options) { return { mark: options.mark ?? 0 } }
  async run(options) { return { mark: options.mark } }
}

class SlowTask extends BaseTask {
  static type = 'slow'
  static cron = '0 0 * * * *'
  validate(options) { return options }
  async run() { await new Promise((resolve) => setTimeout(resolve, 80)); return { done: true } }
}

const registry = createTaskRegistry([PingTask, SlowTask])
const logger = { info() {}, warn() {}, error() {} }
const database = createDatabase(':memory:')
const models = database.catalog
const configPath = path.join(temporary, 'tasks.yaml')

const write = (yaml) => fs.writeFile(configPath, yaml)

test('task configuration rejects unknown types, bad cron and misspelled keys', () => {
  const base = (overrides) => `tasks:\n  - type: ping\n    cron: "0 0 * * * *"\n${overrides ?? ''}`
  assert.equal(parseTaskConfig(base(), registry).tasks[0].type, 'ping')

  assert.throws(() => parseTaskConfig('tasks:\n  - type: nope\n    cron: "0 0 * * * *"', registry), /未注册/)
  assert.throws(() => parseTaskConfig('tasks:\n  - type: ping\n    cron: "not a cron"', registry), /cron/)
  assert.throws(() => parseTaskConfig('tasks:\n  - type: ping\n    cron: "0 0 * * * *"\n  - type: ping\n    cron: "0 0 * * * *"', registry), /重复/)
  assert.throws(() => parseTaskConfig('tasks: []\nextra: 1', registry), /顶层字段/)
  assert.throws(() => parseTaskConfig('tasks:\n  - type: ping\n    cron: "0 0 * * * *"\n    unknown: 1', registry), /不支持字段/)
  assert.throws(() => parseTaskConfig('tasks:\n  - type: ping\n    cron: "0 0 * * * *"\n    timeoutMs: 10', registry), /timeoutMs/)
  assert.throws(() => parseTaskConfig('tasks:\n  - type: ping\n    cron: "0 0 * * * *"\n    enabled: "yes"', registry), /布尔/)
})

test('the manager schedules, records every run and reports next run time', async () => {
  await write('timezone: Asia/Shanghai\ntasks:\n  - type: ping\n    cron: "0 0 * * * *"\n    options:\n      mark: 7\n')
  const manager = createSchedulerManager({ configPath, registry, context: {}, models, logger })
  try {
    await manager.start()
    const [entry] = manager.list()
    assert.equal(entry.type, 'ping')
    assert.equal(entry.enabled, true)
    assert.deepEqual(entry.options, { mark: 7 })
    assert.ok(entry.nextRun)

    const run = await manager.runNow('ping')
    assert.equal(run.ok, true)
    const rows = models.task.list({ limit: 10, offset: 0 }).items
    assert.equal(rows.length, 1)
    assert.equal(rows[0].type, 'ping')
    assert.equal(rows[0].status, 'succeeded')
    assert.deepEqual(rows[0].result, { mark: 7 })
    assert.ok(rows[0].startedAt)
    assert.ok(rows[0].finishedAt)
  } finally { await manager.stop() }
})

test('overlapping runs of one task are skipped instead of queued', async () => {
  await write('tasks:\n  - type: slow\n    cron: "0 0 * * * *"\n')
  const manager = createSchedulerManager({ configPath, registry, context: {}, models, logger })
  try {
    await manager.start()
    const first = manager.runNow('slow')
    const second = await manager.runNow('slow')
    assert.deepEqual(second, { skipped: true })
    assert.equal((await first).ok, true)
  } finally { await manager.stop() }
})

test('disabled tasks are not scheduled but can still be triggered by hand', async () => {
  await write('tasks:\n  - type: ping\n    cron: "0 0 * * * *"\n    enabled: false\n')
  const manager = createSchedulerManager({ configPath, registry, context: {}, models, logger })
  try {
    await manager.start()
    const [entry] = manager.list()
    assert.equal(entry.enabled, false)
    assert.equal(entry.nextRun, null, '未启用自动调度时不应有下次运行时间')
    assert.equal(entry.running, false)

    const before = models.task.list({ limit: 1, offset: 0 }).total
    const result = await manager.runNow('ping')
    assert.equal(result.ok, true)
    assert.equal(models.task.list({ limit: 1, offset: 0 }).total, before + 1)
    const [row] = models.task.list({ limit: 1, offset: 0 }).items
    assert.equal(row.type, 'ping')
    assert.equal(row.status, 'succeeded')
  } finally { await manager.stop() }
})

test('reload swaps changed schedules and keeps the previous config when the file is invalid', async () => {
  await write('tasks:\n  - type: ping\n    cron: "0 0 * * * *"\n')
  const manager = createSchedulerManager({ configPath, registry, context: {}, models, logger })
  try {
    await manager.start()
    const before = manager.list()[0].nextRun

    await write('tasks:\n  - type: ping\n    cron: "0 30 * * * *"\n')
    assert.equal((await manager.reload()).ok, true)
    assert.equal(manager.list()[0].cron, '0 30 * * * *')
    assert.notEqual(manager.list()[0].nextRun, before)

    await write('tasks:\n  - type: nope\n    cron: "0 0 * * * *"\n')
    const failed = await manager.reload()
    assert.equal(failed.ok, false)
    assert.equal(manager.list()[0].cron, '0 30 * * * *', '无效配置不会替换正在运行的调度')
  } finally { await manager.stop() }
})

test('an invalid configuration fails startup instead of silently scheduling nothing', async () => {
  await write('tasks:\n  - type: nope\n    cron: "0 0 * * * *"\n')
  const manager = createSchedulerManager({ configPath, registry, context: {}, models, logger })
  await assert.rejects(() => manager.start(), /未注册/)
  await manager.stop()
})

test('stopping clears every scheduled job', async () => {
  await write('tasks:\n  - type: ping\n    cron: "0 0 * * * *"\n')
  const manager = createSchedulerManager({ configPath, registry, context: {}, models, logger })
  await manager.start()
  assert.ok(manager.list()[0].nextRun)
  await manager.stop()
  assert.equal(manager.list()[0].nextRun, null)
})
