import { HttpError } from '../errors.ts'
import { bodyFields, id, invalid, json, mustExist, number, page, text, write } from './catalog-validation.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { ListResult, TaskRecord } from '../types.ts'

export interface TaskService {
  get(value: unknown): TaskRecord
  list(query?: Record<string, unknown>): ListResult<TaskRecord>
  create(body: unknown): TaskRecord
  cancel(value: unknown): TaskRecord
  remove(value: unknown): { ok: boolean }
  claimNext(): TaskRecord | null
  progress(value: unknown, progress: unknown): TaskRecord
  complete(value: unknown, result?: unknown): TaskRecord
  fail(value: unknown, error: unknown): TaskRecord
}

const REQUIRED_CREATE_FIELDS = ['type']
const ACTIVE_STATUSES = ['queued', 'running']
const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled']

export function createTaskService(models: CatalogModels): TaskService {
  const model = models.task
  const get = (value: unknown): TaskRecord => mustExist(model, { id: id(value) }, '任务')
  const transition = (current: TaskRecord, changes: Partial<TaskRecord>): TaskRecord => {
    const result: TaskRecord | null = write(() => model.transition(current, changes))
    if (!result) throw new HttpError(409, '任务状态已改变，请重新读取')
    return result
  }
  const running = (value: unknown): TaskRecord => {
    const current = get(value)
    if (current.status !== 'running') throw new HttpError(409, '任务未处于执行状态')
    return current
  }
  return {
    get,
    list(query: Record<string, unknown> = {}): ListResult<TaskRecord> {
      return model.list(page(query, { type: text('任务类型', 64), status: (value: unknown) => typeof value === 'string' && TASK_STATUSES.includes(value) ? value : invalid('任务状态无效') }))
    },
    create(body: unknown): TaskRecord {
      const value = bodyFields(body, {
        type: (fieldValue: unknown) => {
          const name = text('任务类型', 64)(fieldValue)
          return /^[a-z][a-z0-9_-]{0,63}$/.test(name) ? name : invalid('任务类型无效')
        },
        payload: (fieldValue: unknown) => json(fieldValue), runAfter: (fieldValue: unknown) => number(fieldValue, '任务执行时间'),
      }, { payload: {}, runAfter: 0 }, REQUIRED_CREATE_FIELDS)
      return write(() => model.create(value))
    },
    cancel(value: unknown): TaskRecord {
      const current = get(value)
      if (current.status === 'cancelled') return current
      if (!ACTIVE_STATUSES.includes(current.status)) throw new HttpError(409, '已结束任务不能取消')
      return transition(current, { status: 'cancelled', finishedAt: Date.now() })
    },
    remove(value: unknown): { ok: boolean } {
      const current = get(value)
      if (ACTIVE_STATUSES.includes(current.status)) throw new HttpError(409, '请先取消任务再删除')
      write(() => model.remove({ id: current.id }))
      return { ok: true }
    },
    // Worker-facing methods. HTTP creation only queues a record; no executor runs yet.
    claimNext(): TaskRecord | null { return write(() => model.claimNext(Date.now())) },
    progress(value: unknown, progress: unknown): TaskRecord { return transition(running(value), { progress: number(progress, '任务进度', 0, 100, false) }) },
    complete(value: unknown, result: unknown = null): TaskRecord { return transition(running(value), { status: 'succeeded', progress: 100, result: json(result, false), finishedAt: Date.now() }) },
    fail(value: unknown, error: unknown): TaskRecord { return transition(running(value), { status: 'failed', error: text('错误摘要', 2000)(error), finishedAt: Date.now() }) },
  }
}
