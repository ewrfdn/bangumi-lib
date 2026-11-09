import path from 'node:path'
import { HttpError } from '../errors.ts'
import type { ListQuery, ListResult, Model } from '../types.ts'

/**
 * A single request-field parser. Request bodies and query strings are JSON: their shape is dynamic,
 * so every parser receives an untyped value and validates/normalizes it before returning.
 */
export type FieldParser = (value: any) => unknown

/** Raw list query parameters; values arrive as strings from HTTP and are normalized by `page`. */
export type QueryParams = Record<string, unknown>

/** Normalized pagination plus the filters that were actually supplied. */
export interface ListPage extends ListQuery {
  filters: Record<string, unknown>
}

/** Declarative description of one CRUD resource; models alone build and execute SQL. */
export interface ResourceServiceOptions {
  validators: Record<string, FieldParser>
  defaults?: Record<string, unknown>
  required?: string[]
  /** Receives raw row/shape data (dynamic JSON), returns the row to persist. */
  normalize?: (data: Record<string, any>) => Record<string, any>
  computed?: string[]
  filters?: Record<string, FieldParser>
  searchable?: boolean
}

/** The CRUD surface shared by media, local media and local videos. */
export interface CatalogResource<T> {
  list(query?: QueryParams): ListResult<T>
  get(value: unknown): T
  create(body: unknown): T
  update(value: unknown, body: unknown): T | null
  remove(value: unknown): { ok: true }
}

/** Declared with an explicit function type so control-flow analysis knows it never returns. */
export const invalid: (message: string) => never = (message: string): never => { throw new HttpError(400, message) }

export function number(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) invalid(`${name} 无效`)
  return value
}

export function id(value: unknown): number {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) value = Number(value)
  return number(value, 'ID', 1)
}

export function videoIndex(value: unknown): number {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) value = Number(value)
  return number(value, '集号', 0, 1_000_000, false)
}

export const text = (name: string, max = 500, empty = false): ((value: unknown) => string) => (value: unknown): string => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (!empty && !value.trim())) invalid(`${name} 无效`)
  return value.trim()
}

export const nullable = <T>(parse: (value: unknown) => T): ((value: unknown) => T | null) =>
  (value: unknown): T | null => value === null ? null : parse(value)

export const boolean = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid('布尔字段无效')

export function json(value: unknown, objectOnly = true): unknown {
  if (objectOnly && (!value || typeof value !== 'object' || Array.isArray(value))) invalid('需要 JSON 对象')
  try {
    const serialized = JSON.stringify(value, (key, item) => {
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) throw new Error()
      return item
    })
    if (!serialized || Buffer.byteLength(serialized) > 65536) throw new Error()
    return JSON.parse(serialized)
  } catch { invalid('JSON 内容无效或超过 64 KB') }
}

export function relativePath(value: unknown, allowRoot = false): string {
  if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) invalid('相对路径无效')
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.includes(':') || normalized.split('/').includes('..')) invalid('路径必须位于媒体库内')
  const result = normalized.split('/').filter((part: string) => part && part !== '.').join('/')
  if (!allowRoot && !result) invalid('文件路径不能为空')
  return result
}

/**
 * Applies `validators` to an untrusted request body. The result is a dynamic JSON object:
 * `any` is explicit so callers can read validated fields without re-declaring the request shape.
 */
export function bodyFields(body: unknown, validators: Record<string, FieldParser>, defaults: Record<string, unknown> = {}, required: string[] = []): Record<string, any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('请求正文必须为对象')
  const record = body as Record<string, unknown>
  for (const key of Object.keys(record)) if (!Object.hasOwn(validators, key)) invalid(`不支持字段：${key}`)
  const source = { ...defaults, ...record }, result: Record<string, any> = {}
  for (const key of required) if (!Object.hasOwn(source, key)) invalid(`缺少字段：${key}`)
  for (const [key, value] of Object.entries(source)) result[key] = validators[key](value)
  return result
}

export function page(query: QueryParams = {}, filters: Record<string, FieldParser> = {}, searchable = false): ListPage {
  const names = ['limit', 'offset', ...(searchable ? ['q'] : []), ...Object.keys(filters)]
  for (const key of Object.keys(query)) if (!names.includes(key)) invalid(`不支持查询参数：${key}`)
  const numeric = (value: unknown, fallback: number, max: number, min: number): number => {
    if (value === undefined) return fallback
    if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value)
    return number(value, '分页参数', min, max)
  }
  const result: ListPage = { limit: numeric(query.limit, 50, 200, 1), offset: numeric(query.offset, 0, 10_000_000, 0), filters: {} }
  for (const [key, parse] of Object.entries(filters)) if (query[key] !== undefined) result.filters[key] = parse(query[key])
  if (searchable && query.q !== undefined) result.q = text('搜索关键词', 200, true)(query.q)
  return result
}

export function write<T>(operation: () => T): T {
  try { return operation() }
  catch (error) {
    // Driver errors are plain objects; read the SQLite code without narrowing the throw type.
    const code = (error as { code?: string }).code
    if (code?.startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, '记录重复、仍被其他记录引用或关联不一致', 'CATALOG_CONFLICT')
    if (code === 'SQLITE_BUSY') throw new HttpError(503, '数据库忙，请稍后重试')
    throw error
  }
}

export const mustExist = <T>(model: Pick<Model<T>, 'find'>, key: Record<string, unknown>, name = '记录'): T => {
  const record = model.find(key)
  if (!record) throw new HttpError(404, `${name}不存在`)
  return record
}

/** Shared CRUD orchestration; models alone build and execute SQL. */
export function resourceService<T>(model: Model<T>, {
  validators, defaults = {}, required = [], normalize = data => data, computed = [], filters = {}, searchable = false,
}: ResourceServiceOptions): CatalogResource<T> {
  const writable = [...Object.keys(validators), ...computed]
  const values = (data: Record<string, any>): Record<string, unknown> =>
    Object.fromEntries(writable.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]))
  return {
    list(query?: QueryParams): ListResult<T> { return model.list(page(query, filters, searchable)) },
    get(value: unknown): T { return mustExist(model, { id: id(value) }) },
    create(body: unknown): T {
      const record = normalize(bodyFields(body, validators, defaults, required))
      return write(() => model.create(values(record)))
    },
    update(value: unknown, body: unknown): T | null {
      const key = { id: id(value) }, current = mustExist(model, key)
      const patch = bodyFields(body, validators)
      if (!Object.keys(patch).length) invalid('没有需要更新的字段')
      const record = normalize({ ...current, ...patch })
      return write(() => model.update(key, values(record)))
    },
    remove(value: unknown): { ok: true } {
      const key = { id: id(value) }
      mustExist(model, key)
      write(() => model.remove(key))
      return { ok: true }
    },
  }
}
export const baseName = (value: string): string => path.posix.basename(value)
