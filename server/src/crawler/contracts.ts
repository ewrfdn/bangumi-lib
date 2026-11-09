import { CrawlerError } from './crawler-error.ts'
import type { Logger } from '../types.ts'

/**
 * JSON boundary: crawler payloads, provider responses and preview drafts are
 * untrusted JSON. Fields stay `any` until the guards/validators below accept
 * them; nothing outside this module should treat them as typed data.
 */
export type JsonRecord = Record<string, any>

/** One search hit as published by a crawler. */
export interface SearchCandidate {
  source: string
  sourceId: string
  sourceUrl: string
  title: string
  originalTitle?: string | null
  mediaType: string
  platform?: string | null
  airedOn?: string | null
  cover?: string | null
}

/** One page of search hits; `total` is null when the source cannot tell. */
export interface SearchResult {
  items: SearchCandidate[]
  total: number | null
  limit: number
  offset: number
}

/** Source identity stored in `MediaDraft.attribute.metadata`. */
export interface MediaDraftMetadata {
  source: string
  sourceId: string
  originalTitle?: string
  aliases?: string[]
  platform?: string
  fetchedAt?: number
}

/** Validated payload that a crawler maps into a library media row. */
export interface MediaDraft {
  title: string
  mediaType?: string
  season?: number
  episodeCount?: number
  description?: string
  rating?: number
  tags?: string[]
  airedOn?: string
  cover?: string
  series?: string
  dataSource: string
  dataSourceUrl: string
  attribute: { metadata: MediaDraftMetadata }
}

/** Options accepted by `validateMediaDraft`. */
export interface MediaDraftOptions {
  source?: string
  logger?: Logger
}

/** Options accepted by `validateSearchResult`; paging is validated, not inferred. */
export interface SearchResultOptions {
  source: string
  limit: number
  offset: number
  logger?: Logger
}

const mediaKeys = new Set(['title', 'cover', 'mediaType', 'season', 'episodeCount', 'description', 'rating', 'tags', 'airedOn', 'series', 'dataSource', 'dataSourceUrl', 'attribute'])
const metadataKeys = new Set(['source', 'sourceId', 'originalTitle', 'aliases', 'platform', 'fetchedAt'])
const candidateKeys = new Set(['source', 'sourceId', 'sourceUrl', 'title', 'originalTitle', 'mediaType', 'platform', 'airedOn', 'cover'])
const has = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

/** True for plain JSON objects (including null-prototype objects). */
export const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

export function isValidDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 8192) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

function failure(source: string, message: string): never { throw new CrawlerError('INVALID_RESULT', source, message) }

function keys(value: JsonRecord, allowed: ReadonlySet<string>, source: string, label: string): void {
  if (Object.keys(value).some(key => !allowed.has(key))) failure(source, `${label}包含不支持的字段`)
}

interface StringOptions {
  empty?: boolean
  trim?: boolean
  truncate?: boolean
  logger?: Logger
}

function string(value: unknown, max: number, source: string, label: string, { empty = false, trim = true, truncate = false, logger }: StringOptions = {}): string {
  if (typeof value !== 'string' || value.includes('\0')) failure(source, `${label}必须为有效文本`)
  let result = trim ? value.trim() : value
  if (!empty && !result) failure(source, `${label}不能为空`)
  if (result.length > max) {
    if (!truncate) failure(source, `${label}过长`)
    result = result.slice(0, max)
    logger?.warn?.({ source, field: label }, '爬取结果超过字段长度，已裁剪')
  }
  return result
}

function list(value: unknown, maxItems: number, maxLength: number, source: string, label: string, logger?: Logger): string[] {
  if (!Array.isArray(value)) failure(source, `${label}必须为数组`)
  const result: string[] = []
  let truncated = value.length > maxItems
  for (const item of value) {
    const text = string(item, maxLength, source, label, { truncate: true, logger })
    if (!result.includes(text)) result.push(text)
    if (result.length >= maxItems) break
  }
  if (truncated) logger?.warn?.({ source, field: label }, '爬取结果超过列表长度，已裁剪')
  return result
}

/** Revalidate both source results and edited preview drafts without trusting extra fields. */
export function validateMediaDraft(value: unknown, options: MediaDraftOptions = {}): MediaDraft {
  const { logger } = options
  const hinted = value as JsonRecord | null | undefined
  const dataSourceHint = hinted?.dataSource
  const source = options.source ?? (typeof dataSourceHint === 'string' ? dataSourceHint : 'unknown')
  if (!isRecord(value)) failure(source, '媒体草稿必须为对象')
  keys(value, mediaKeys, source, '媒体草稿')
  // `attribute` is assigned by the metadata validation below, before this draft can escape.
  const result = {
    title: string(value.title, 500, source, '标题', { truncate: true, logger }),
    dataSource: string(value.dataSource, 100, source, '来源'),
    dataSourceUrl: string(value.dataSourceUrl, 8192, source, '来源链接'),
  } as MediaDraft
  if (result.dataSource !== source || !/^[a-z][a-z0-9-]{0,99}$/.test(result.dataSource)) failure(source, '来源身份无效')
  if (!isHttpUrl(result.dataSourceUrl)) failure(source, '来源链接无效')
  if (!isRecord(value.attribute) || !isRecord(value.attribute.metadata)) failure(source, '缺少来源元数据')
  keys(value.attribute, new Set(['metadata']), source, '来源属性')
  const metadata = value.attribute.metadata
  keys(metadata, metadataKeys, source, '来源元数据')
  const identity: MediaDraftMetadata = {
    source: string(metadata.source, 100, source, '元数据来源'),
    sourceId: string(metadata.sourceId, 1000, source, '来源条目ID'),
  }
  if (identity.source !== source) failure(source, '来源身份不一致')
  for (const field of ['originalTitle', 'platform'] as const) if (has(metadata, field)) identity[field] = string(metadata[field], field === 'platform' ? 100 : 500, source, field, { truncate: true, logger })
  if (has(metadata, 'aliases')) identity.aliases = list(metadata.aliases, 100, 500, source, '别名', logger)
  if (has(metadata, 'fetchedAt')) {
    if (!Number.isSafeInteger(metadata.fetchedAt) || metadata.fetchedAt < 0) failure(source, '获取时间无效')
    identity.fetchedAt = metadata.fetchedAt
  }
  result.attribute = { metadata: identity }
  for (const field of ['mediaType', 'series', 'description'] as const) if (has(value, field)) result[field] = string(value[field], field === 'mediaType' ? 32 : field === 'description' ? 20000 : 500, source, field, { empty: field === 'description', truncate: field !== 'mediaType', logger })
  if (has(value, 'cover')) {
    if (!isHttpUrl(value.cover)) failure(source, '封面链接无效')
    result.cover = value.cover
  }
  for (const [field, min, max] of [['season', 1, 10000], ['episodeCount', 1, 100000]] as const) if (has(value, field)) {
    if (!Number.isInteger(value[field]) || value[field] < min || value[field] > max) failure(source, `${field}无效`)
    result[field] = value[field]
  }
  if (has(value, 'rating')) {
    if (!Number.isFinite(value.rating) || value.rating < 0 || value.rating > 10) failure(source, '评分无效')
    result.rating = value.rating
  }
  if (has(value, 'airedOn')) {
    if (!isValidDate(value.airedOn)) failure(source, '播出日期无效')
    result.airedOn = value.airedOn
  }
  if (has(value, 'tags')) result.tags = list(value.tags, 100, 64, source, '标签', logger)
  let aliasesCropped = false
  while (Buffer.byteLength(JSON.stringify(result.attribute), 'utf8') > 65536 && identity.aliases?.length) {
    identity.aliases.pop()
    aliasesCropped = true
  }
  if (aliasesCropped) logger?.warn?.({ source, field: 'aliases' }, '来源别名超过属性大小限制，已裁剪')
  if (Buffer.byteLength(JSON.stringify(result.attribute), 'utf8') > 65536) failure(source, '来源元数据过大')
  return result
}

export function validateSearchResult(value: unknown, options: SearchResultOptions): SearchResult {
  const { source, limit, offset, logger } = options
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > limit) failure(source, '搜索结果结构无效')
  if (value.total !== null && (!Number.isSafeInteger(value.total) || value.total < 0)) failure(source, '搜索结果总数无效')
  if (value.limit !== limit || value.offset !== offset) failure(source, '搜索结果分页不一致')
  const items = value.items.map((candidate: unknown): SearchCandidate => {
    if (!isRecord(candidate)) failure(source, '搜索候选无效')
    keys(candidate, candidateKeys, source, '搜索候选')
    if (candidate.source !== source) failure(source, '搜索候选来源不一致')
    const item: SearchCandidate = { source, sourceId: string(candidate.sourceId, 1000, source, '来源条目ID'), sourceUrl: string(candidate.sourceUrl, 8192, source, '来源链接'), title: string(candidate.title, 500, source, '标题', { truncate: true, logger }), mediaType: string(candidate.mediaType, 32, source, '媒体类型') }
    if (!isHttpUrl(item.sourceUrl)) failure(source, '搜索候选来源链接无效')
    for (const field of ['originalTitle', 'platform'] as const) if (has(candidate, field)) item[field] = candidate[field] === null ? null : string(candidate[field], 500, source, field, { truncate: true, logger })
    for (const field of ['cover', 'airedOn'] as const) if (has(candidate, field)) {
      if (candidate[field] !== null && !(field === 'cover' ? isHttpUrl(candidate[field]) : isValidDate(candidate[field]))) failure(source, `搜索候选${field}无效`)
      item[field] = candidate[field]
    }
    return item
  })
  return { items, total: value.total, limit, offset }
}
