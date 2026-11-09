import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { Cron } from 'croner'
import type { TaskRegistry } from './registry.ts'

const ROOT_KEYS = new Set(['timezone', 'tasks'])
const ENTRY_KEYS = new Set(['type', 'cron', 'enabled', 'timeoutMs', 'options'])
const MAX_TASKS = 50
const MAX_TIMEOUT = 24 * 60 * 60 * 1000

export interface ParsedTask {
  type: string
  cron: string
  enabled: boolean
  timeoutMs: number
  options: Record<string, unknown>
}

export interface TaskConfig {
  timezone: string
  tasks: ParsedTask[]
  missing?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return true } catch { return false }
}

export function validCron(expression: string, timezone: string): boolean {
  try {
    const job = new Cron(expression, { timezone, paused: true })
    job.stop()
    return true
  } catch { return false }
}

/** 校验 YAML 文本；类型必须在 registry 中，未知键直接报错，避免拼写错误被静默忽略。 */
export function parseTaskConfig(raw: string, registry: TaskRegistry, { defaultTimezone = 'Asia/Shanghai' }: { defaultTimezone?: string } = {}): TaskConfig {
  let document: unknown
  try { document = parse(raw) } catch (error) {
    throw new Error(`tasks.yaml 不是合法 YAML：${(error as Error).message}`)
  }
  if (document === null || document === undefined) return { timezone: defaultTimezone, tasks: [] }
  if (!isRecord(document)) throw new Error('tasks.yaml 顶层必须是对象')
  for (const key of Object.keys(document)) if (!ROOT_KEYS.has(key)) throw new Error(`tasks.yaml 不支持顶层字段：${key}`)

  const timezone = typeof document.timezone === 'string' ? document.timezone : defaultTimezone
  if (!validTimezone(timezone)) throw new Error(`tasks.yaml 时区无效：${timezone}`)
  if (!Array.isArray(document.tasks)) throw new Error('tasks.yaml 必须包含 tasks 数组')
  if (document.tasks.length > MAX_TASKS) throw new Error(`tasks.yaml 最多 ${MAX_TASKS} 个任务`)

  const seen = new Set<string>()
  const tasks = document.tasks.map((entry: unknown, index: number) => {
    const where = `tasks[${index}]`
    if (!isRecord(entry)) throw new Error(`${where} 必须是对象`)
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) throw new Error(`${where} 不支持字段：${key}`)
    if (typeof entry.type !== 'string' || !registry.has(entry.type)) throw new Error(`${where}.type 未注册：${String(entry.type)}`)
    if (seen.has(entry.type)) throw new Error(`${where}.type 重复：${entry.type}`)
    seen.add(entry.type)

    const TaskClass = registry.get(entry.type)
    const cron = typeof entry.cron === 'string' ? entry.cron : TaskClass.cron
    if (!cron.trim() || !validCron(cron, timezone)) throw new Error(`${where}.cron 无效：${cron}`)

    const enabled = entry.enabled ?? true
    if (typeof enabled !== 'boolean') throw new Error(`${where}.enabled 必须是布尔值`)

    const timeoutMs = entry.timeoutMs ?? TaskClass.timeoutMs
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT) {
      throw new Error(`${where}.timeoutMs 必须是 1000 到 ${MAX_TIMEOUT} 的整数`)
    }

    const options = entry.options ?? {}
    if (!isRecord(options)) throw new Error(`${where}.options 必须是对象`)

    return { type: entry.type, cron: cron.trim(), enabled, timeoutMs, options: { ...TaskClass.options, ...options } }
  })

  return { timezone, tasks }
}

export async function readTaskConfig(file: string, registry: TaskRegistry, options?: { defaultTimezone?: string }): Promise<TaskConfig> {
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { timezone: options?.defaultTimezone ?? 'Asia/Shanghai', tasks: [], missing: true }
    }
    throw error
  }
  return { ...parseTaskConfig(raw, registry, options), missing: false }
}
