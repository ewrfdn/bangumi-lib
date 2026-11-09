import { HttpError } from '../errors.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { Logger, TaskRecord } from '../types.ts'

/** 一次后台运行的结果；ok 与 taskId 始终返回，便于调用方统一记录。 */
export interface TaskRunResult {
  ok: boolean
  taskId: number
  result?: unknown
  error?: string
}

/** start 的返回值：重入时只有 skipped。 */
export interface TaskStartResult {
  skipped?: boolean
  ok?: boolean
  taskId?: number
  promise?: Promise<TaskRunResult>
}

export interface TaskStartOptions {
  key: string
  type: string
  payload?: Record<string, unknown>
  timeoutMs?: number
}

export interface TaskHandlerContext {
  signal: AbortSignal
  logger?: Logger
}

export interface TaskRunner {
  start(options: TaskStartOptions, handler: (context: TaskHandlerContext) => unknown): TaskStartResult
  isRunning(key: string): boolean
  size(): number
  abortAll(): void
}

export interface TaskRunnerDependencies {
  models: CatalogModels
  logger?: Logger
}

const summarize = (error: unknown): string => {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return String(message || error || '未知错误').slice(0, 2000)
}
const jsonSafe = (value: unknown): unknown => {
  try { return JSON.parse(JSON.stringify(value ?? null)) } catch { return { note: '结果无法序列化' } }
}

/**
 * 后台运行的统一入口：写 task 记录、限制重入、超时中止。
 * 调度器与手动触发共用，保证两条路径的观测数据一致。
 */
export function createTaskRunner({ models, logger }: TaskRunnerDependencies): TaskRunner {
  const running = new Map<string, AbortController>()

  function start({ key, type, payload = {}, timeoutMs = 15 * 60 * 1000 }: TaskStartOptions, handler: (context: TaskHandlerContext) => unknown): TaskStartResult {
    if (running.has(key)) return { skipped: true }
    if (typeof handler !== 'function') throw new HttpError(400, '任务处理函数无效')

    const controller = new AbortController()
    running.set(key, controller)
    let record: TaskRecord = models.task.create({ type, payload })
    // 并发修改时 transition 返回 null；保持原有“先覆盖再继续”的行为，类型按记录继续。
    record = models.task.transition(record, { status: 'running', startedAt: Date.now() }) as TaskRecord
    const timer = setTimeout(() => controller.abort(new Error('任务超过时间上限')), timeoutMs)

    const promise = Promise.resolve()
      .then(() => handler({ signal: controller.signal, logger }))
      .then((result): TaskRunResult => {
        models.task.transition(record, { status: 'succeeded', progress: 100, result: jsonSafe(result), finishedAt: Date.now() })
        logger?.info?.({ task: type, key }, '任务完成')
        return { ok: true, taskId: record.id, result }
      })
      .catch((error: unknown): TaskRunResult => {
        const message = summarize(error)
        models.task.transition(record, { status: 'failed', error: message, finishedAt: Date.now() })
        logger?.error?.({ task: type, key, code: (error as { code?: string } | null | undefined)?.code }, '任务失败')
        return { ok: false, taskId: record.id, error: message }
      })
      .finally(() => {
        clearTimeout(timer)
        running.delete(key)
      })

    return { ok: true, taskId: record.id, promise }
  }

  return {
    start,
    isRunning: (key: string): boolean => running.has(key),
    size: (): number => running.size,
    abortAll(): void {
      for (const controller of running.values()) controller.abort(new Error('服务关闭'))
      running.clear()
    },
  }
}
