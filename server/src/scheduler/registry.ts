import { ScanLibraryTask } from './tasks/scan-library.task.ts'
import type { BaseTask, TaskContext } from './base.task.ts'

/** 任务类的静态契约：manager 只用这些字段，实例化后调用 validate/run。 */
export interface TaskClass {
  new (context: TaskContext): BaseTask<any>
  type: string
  cron: string
  timeoutMs: number
  options: Record<string, unknown>
}

/** 显式白名单：新增任务必须在这里注册，避免配置文件加载任意代码。 */
const DEFAULT_TASKS: TaskClass[] = [ScanLibraryTask]

export interface TaskRegistry {
  get(type: string): TaskClass
  has(type: string): boolean
  list(): string[]
}

export function createTaskRegistry(classes: TaskClass[] = DEFAULT_TASKS): TaskRegistry {
  const types = new Map<string, TaskClass>()
  for (const TaskClass of classes) {
    if (typeof TaskClass?.type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(TaskClass.type)) {
      throw new Error(`定时任务类型无效：${TaskClass?.name ?? 'unknown'}`)
    }
    if (types.has(TaskClass.type)) throw new Error(`定时任务类型重复：${TaskClass.type}`)
    types.set(TaskClass.type, TaskClass)
  }
  return {
    get(type: string): TaskClass {
      const TaskClass = types.get(type)
      if (!TaskClass) throw new Error(`未注册的定时任务类型：${type}`)
      return TaskClass
    },
    has: (type: string) => types.has(type),
    list: () => [...types.keys()],
  }
}
