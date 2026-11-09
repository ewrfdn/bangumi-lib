import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { Cron } from 'croner'
import { readTaskConfig } from './task-config.ts'
import { createTaskRunner } from '../service/task-runner.service.ts'
import type { BaseTask, TaskContext } from './base.task.ts'
import type { TaskClass, TaskRegistry } from './registry.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { Logger } from '../types.ts'

interface ScheduledEntry {
  type: string
  cron: string
  enabled: boolean
  timeoutMs: number
  options: Record<string, unknown>
  instance: BaseTask<any>
}

interface LoadedConfig {
  timezone: string
  tasks: ScheduledEntry[]
  missing?: boolean
}

interface StartedRun {
  skipped?: boolean
  taskId?: number
  promise?: Promise<{ ok: boolean; taskId: number; result?: unknown; error?: string }>
}

export type RunNowResult =
  | { skipped: true }
  | { taskId: number }
  | { ok: boolean; taskId: number; result?: unknown; error?: string }

export interface SchedulerManagerOptions {
  configPath: string
  timezone?: string
  registry: TaskRegistry
  context: TaskContext
  models: CatalogModels
  logger?: Logger
  runner?: ReturnType<typeof createTaskRunner>
  reloadDebounceMs?: number
}

/**
 * 读取 tasks.yaml，按 type 实例化任务并用 cron 调度。
 * 同一类型上次未结束时跳过本次；配置变更热加载，不影响正在运行的任务。
 */
export function createSchedulerManager({
  configPath, timezone = 'Asia/Shanghai', registry, context, models, logger, runner, reloadDebounceMs = 300,
}: SchedulerManagerOptions) {
  const taskRunner = runner ?? createTaskRunner({ models, logger })
  const jobs = new Map<string, { job: Cron; entry: ScheduledEntry }>()
  let config: LoadedConfig = { timezone, tasks: [] }
  let watcher: FSWatcher | null = null
  let reloadTimer: NodeJS.Timeout | null = null
  let started = false

  async function load(): Promise<LoadedConfig> {
    const parsed = await readTaskConfig(configPath, registry, { defaultTimezone: timezone })
    const tasks = parsed.tasks.map((entry): ScheduledEntry => {
      const TaskClass: TaskClass = registry.get(entry.type)
      const instance = new TaskClass(context)
      const options = instance.validate(entry.options) as Record<string, unknown>
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error(`${entry.type}.validate 必须返回对象`)
      }
      return { ...entry, options, instance }
    })
    return { timezone: parsed.timezone, tasks, missing: parsed.missing }
  }

  const sameSchedule = (left: ScheduledEntry, right: ScheduledEntry): boolean =>
    left.cron === right.cron && left.timeoutMs === right.timeoutMs &&
    JSON.stringify(left.options) === JSON.stringify(right.options)

  function execute(entry: ScheduledEntry): StartedRun {
    return taskRunner.start(
      { key: entry.type, type: entry.type, payload: entry.options, timeoutMs: entry.timeoutMs },
      ({ signal, logger: runLogger }: { signal: AbortSignal; logger?: Logger }) =>
        entry.instance.run(entry.options, { signal, logger: runLogger }),
    ) as StartedRun
  }

  function schedule(entry: ScheduledEntry): void {
    const job = new Cron(entry.cron, { timezone: config.timezone }, () => { void execute(entry) })
    jobs.set(entry.type, { job, entry })
  }

  function apply(next: LoadedConfig): void {
    const upcoming = new Map(next.tasks.filter((entry) => entry.enabled).map((entry) => [entry.type, entry]))
    for (const [type, current] of jobs) {
      const target = upcoming.get(type)
      if (target && sameSchedule(current.entry, target)) continue
      current.job.stop()
      jobs.delete(type)
    }
    for (const entry of upcoming.values()) {
      if (jobs.has(entry.type)) continue
      schedule(entry)
    }
    config = next
  }

  async function reload(): Promise<{ ok: true } | { ok: false; error: string } | { skipped: true }> {
    if (!started) return { skipped: true }
    let next: LoadedConfig
    try { next = await load() } catch (error) {
      logger?.error?.({ error: (error as Error).message }, 'tasks.yaml 无效，保留上一次配置')
      return { ok: false, error: (error as Error).message }
    }
    apply(next)
    logger?.info?.({ tasks: config.tasks.filter((entry) => entry.enabled).map((entry) => entry.type) }, '定时任务配置已加载')
    return { ok: true }
  }

  async function start(): Promise<void> {
    if (started) return
    started = true
    // 启动时配置错误直接抛出：宁可起不来，也不要静默少跑任务。
    apply(await load())
    const directory = path.dirname(configPath)
    const base = path.basename(configPath)
    try {
      watcher = watch(directory, (_event, filename) => {
        if (filename && path.basename(String(filename)) !== base) return
        if (reloadTimer) clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => { void reload() }, reloadDebounceMs)
      })
      watcher.on('error', (error: Error) => logger?.warn?.({ error: error.message }, 'tasks.yaml 监听失败'))
    } catch (error) {
      logger?.warn?.({ error: (error as Error).message }, '无法监听 tasks.yaml，配置变更需要重启')
    }
  }

  async function stop(): Promise<void> {
    started = false
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = null
    watcher?.close()
    watcher = null
    for (const { job } of jobs.values()) job.stop()
    jobs.clear()
    taskRunner.abortAll()
  }

  async function runNow(type: string, { wait = true }: { wait?: boolean } = {}): Promise<RunNowResult> {
    const entry = config.tasks.find((task) => task.type === type)
    if (!entry) throw new Error(`未配置的定时任务：${type}`)
    const startedRun = execute(entry)
    if (startedRun.skipped) return { skipped: true }
    if (!wait) return { taskId: startedRun.taskId as number }
    return (await startedRun.promise) as RunNowResult
  }

  function list(): Array<{ type: string; cron: string; enabled: boolean; options: Record<string, unknown>; timeoutMs: number; running: boolean; nextRun: string | null }> {
    return config.tasks.map((entry) => ({
      type: entry.type, cron: entry.cron, enabled: entry.enabled, options: entry.options,
      timeoutMs: entry.timeoutMs, running: taskRunner.isRunning(entry.type),
      nextRun: jobs.get(entry.type)?.job.nextRun()?.toISOString() ?? null,
    }))
  }

  return { start, stop, reload, runNow, list, get configPath(): string { return configPath }, get timezone(): string { return config.timezone } }
}
