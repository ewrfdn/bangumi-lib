import { HttpError } from '../errors.ts'
import {
  bodyFields, id, json, mustExist, nullable, number, resourceService, text, invalid, write,
} from './catalog-validation.ts'
import type { CatalogResource, FieldParser } from './catalog-validation.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { Media } from '../types.ts'

export const METADATA_FIELDS: readonly string[] = Object.freeze([
  'title', 'cover', 'mediaType', 'season', 'episodeCount', 'description', 'rating', 'tags', 'airedOn', 'series',
])
const metadataKeys = ['source', 'sourceId', 'originalTitle', 'aliases', 'platform', 'fetchedAt']

/** Loose view of `attribute.metadata`; every value is validated again before it is written. */
interface StoredMetadata {
  source?: string
  sourceId?: string
  [key: string]: unknown
}

/** Source identity of a metadata record. */
export interface ImportIdentity {
  source: string
  sourceId: string
}

export interface ImportMetadataContext {
  signal?: AbortSignal
  resolveIdentity?: (current: Media) => ImportIdentity | null
}

export interface MetadataImportOptions {
  metadata: Record<string, unknown>
  mode: 'fillMissing' | 'overwrite'
  fields: string[]
}

export interface CatalogService extends CatalogResource<Media> {
  /** Merge a validated source draft into one media row; returns the updated row. */
  importMetadata(value: unknown, body: unknown, context?: ImportMetadataContext): Media | null
}

const present = (field: string, value: unknown): boolean => value !== undefined && value !== null &&
  !(typeof value === 'string' && !value.trim()) && !(field === 'episodeCount' && value === 0)
const missing = (field: string, value: unknown): boolean => !present(field, value) || (field === 'tags' && Array.isArray(value) && !value.length)
const checkCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new HttpError(499, '操作已取消', 'CANCELLED')
}

/** Shared with Metadata Service so every import entry point enforces the same field policy. */
export function metadataImportOptions(body: unknown): MetadataImportOptions {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('请求正文必须为对象')
  // HTTP JSON body: each field is validated below before it is read.
  const request = body as Record<string, any>
  for (const key of Object.keys(request)) if (!['metadata', 'mode', 'fields'].includes(key)) invalid(`不支持字段：${key}`)
  if (!Object.hasOwn(request, 'metadata')) invalid('缺少字段：metadata')
  const mode: MetadataImportOptions['mode'] = request.mode === undefined ? 'fillMissing' : request.mode
  if (!['fillMissing', 'overwrite'].includes(mode)) invalid('元数据导入模式无效')
  if (request.fields !== undefined && (!Array.isArray(request.fields) || request.fields.length > METADATA_FIELDS.length ||
    request.fields.some((field: unknown) => !METADATA_FIELDS.includes(field as string)))) invalid('元数据导入字段无效')
  if (mode === 'overwrite' && (!request.fields?.length)) invalid('覆盖导入必须明确选择字段')
  return { metadata: request.metadata, mode, fields: [...new Set(request.fields ?? METADATA_FIELDS)] as string[] }
}

export function createCatalogService(models: CatalogModels): CatalogService {
  const validators: Record<string, FieldParser> = {
    title: text('标题'), cover: nullable(text('封面', 8192)), mediaType: text('媒体类型', 32),
    season: value => number(value, '季号', 1, 10000), episodeCount: value => number(value, '集数', 0, 100000),
    description: text('描述', 20000, true), rating: nullable(value => number(value, '评分', 0, 10, false)),
    tags: value => {
      if (!Array.isArray(value) || value.length > 100) invalid('标签必须为数组，最多 100 个')
      return [...new Set(value.map(text('标签', 64)))]
    },
    attribute: value => json(value), series: nullable(text('系列')),
    dataSource: nullable(text('数据源', 100)),
    dataSourceUrl: nullable(value => {
      const address = text('数据源链接', 8192)(value)
      let url: URL
      try { url = new URL(address) } catch { invalid('数据源链接无效') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid('数据源链接需使用 HTTP/HTTPS 且不能包含凭据')
      return address
    }),
    airedOn: nullable(value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('播出日期无效')
      const date = new Date(value)
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid('播出日期无效')
      return value
    }),
  }
  const service: CatalogResource<Media> = resourceService<Media>(models.media, {
    validators,
    defaults: { cover: null, mediaType: 'anime', season: 1, episodeCount: 0, description: '', rating: null, tags: [], attribute: {}, airedOn: null, series: null, dataSource: null, dataSourceUrl: null },
    required: ['title'], searchable: true,
    filters: { mediaType: text('媒体类型', 32), series: text('系列') },
  })
  return {
    ...service,
    importMetadata(value: unknown, body: unknown, { signal, resolveIdentity }: ImportMetadataContext = {}): Media | null {
      checkCancelled(signal)
      const key = { id: id(value) }
      const { metadata, mode, fields } = metadataImportOptions(body)
      const draft = bodyFields(metadata, validators, {}, ['title', 'dataSource', 'dataSourceUrl', 'attribute'])
      const supplied = draft.attribute.metadata
      if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) invalid('缺少来源身份')
      for (const name of Object.keys(supplied)) if (!metadataKeys.includes(name)) invalid('来源元数据字段无效')
      if (!draft.dataSource || !draft.dataSourceUrl || supplied.source !== draft.dataSource) invalid('来源身份不一致')
      const incoming = { ...supplied, source: text('来源', 100)(supplied.source), sourceId: text('来源条目 ID', 1000)(supplied.sourceId),
        fetchedAt: supplied.fetchedAt === undefined ? Date.now() : number(supplied.fetchedAt, '获取时间') }
      return write(() => models.transaction(() => {
        checkCancelled(signal)
        const current = mustExist(models.media, key, '影视')
        const previous = current.attribute?.metadata as StoredMetadata | undefined
        const bound = Boolean(current.dataSource?.trim() || current.dataSourceUrl?.trim() ||
          (previous && (typeof previous !== 'object' || Object.keys(previous).length)))
        const resolved: unknown = resolveIdentity ? resolveIdentity(current) :
          previous?.source === current.dataSource && previous?.sourceId ? { source: previous.source, sourceId: previous.sourceId } : null
        if (resolved && typeof (resolved as { then?: unknown }).then === 'function') throw new TypeError('Identity resolution must be synchronous')
        const identity = resolved as ImportIdentity | null
        const same = identity?.source === incoming.source && identity?.sourceId === incoming.sourceId
        if (bound && !same && mode !== 'overwrite') {
          throw new HttpError(409, '已有来源绑定与导入条目不一致，请明确选择覆盖', 'METADATA_SOURCE_CONFLICT')
        }
        const patch: Record<string, unknown> = {}
        // Media rows are dynamic JSON: the incoming field name is validated by present/missing.
        const currentFields = current as unknown as Record<string, unknown>
        for (const field of fields) {
          if (Object.hasOwn(draft, field) && present(field, draft[field]) && (mode === 'overwrite' || missing(field, currentFields[field]))) {
            patch[field] = draft[field]
          }
        }
        const retained = same && previous && typeof previous === 'object' ?
          Object.fromEntries(metadataKeys.filter(name => Object.hasOwn(previous, name)).map(name => [name, previous[name]])) : {}
        patch.attribute = { ...current.attribute, metadata: { ...retained, ...incoming } }
        patch.dataSource = draft.dataSource
        patch.dataSourceUrl = draft.dataSourceUrl
        // Validate the merged JSON too; two individually valid attributes can exceed the size limit.
        const validated = bodyFields(patch, validators)
        checkCancelled(signal)
        return models.media.update(key, validated)
      }))
    },
  }
}
