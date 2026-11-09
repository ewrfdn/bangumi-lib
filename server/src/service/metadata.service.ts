import { CrawlerError } from '../crawler/crawler-error.ts'
import { validateMediaDraft } from '../crawler/contracts.ts'
import { metadataImportOptions } from './catalog.service.ts'
import { bodyFields, number, text } from './catalog-validation.ts'
import type { CatalogService, ImportIdentity } from './catalog.service.ts'
import type { MediaDraft, SearchResult } from '../crawler/contracts.ts'
import type { Media } from '../types.ts'

export interface CrawlerDescriptor {
  id: string
  displayName: string
  mediaTypes: string[]
  supportsYearFilter: boolean
  supportsOffset: boolean
}

export interface SourceCrawler {
  describe(): CrawlerDescriptor
  search(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<SearchResult>
  fetch(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<MediaDraft>
  parseSourceUrl(url: string): string
  getSourceUrl(sourceId: string): string
}

export interface CrawlerRegistry {
  list(): CrawlerDescriptor[]
  get(source: string): SourceCrawler
}

/** Per-request cancellation context handed in by the HTTP layer. */
export interface CrawlerContext {
  signal?: AbortSignal
}

/** Loose view of `attribute.metadata`; values are re-validated before use. */
interface StoredMetadata {
  source?: string
  sourceId?: string
  [key: string]: unknown
}

export interface MetadataServiceOptions {
  registry: CrawlerRegistry
  catalogService: Pick<CatalogService, 'importMetadata'>
}

export interface MetadataService {
  sources(): CrawlerDescriptor[]
  search(body: unknown, context?: CrawlerContext): Promise<SearchResult>
  preview(body: unknown, context?: CrawlerContext): Promise<MediaDraft>
  apply(mediaId: unknown, body: unknown, context?: CrawlerContext): Media | null
}

const sourceName = text('来源', 100)
/** Pre-migration call sites passed `undefined` when no source was known; keep that runtime value. */
const NO_SOURCE = undefined as unknown as string
const checkCancelled = (signal: AbortSignal | undefined, source?: string): void => {
  if (signal?.aborted) throw new CrawlerError('CANCELLED', source ?? NO_SOURCE, '操作已取消')
}

/** Source access and explicit persistence orchestration; crawlers never receive local media IDs. */
export function createMetadataService({ registry, catalogService }: MetadataServiceOptions): MetadataService {
  const select = (source: unknown): SourceCrawler => registry.get(sourceName(source))
  const descriptor = (crawler: SourceCrawler): CrawlerDescriptor => crawler.describe()
  const resolveIdentity = (current: Media): ImportIdentity | null => {
    const previous = current.attribute?.metadata as StoredMetadata | undefined
    const descriptors = registry.list()
    const canonicalSource = (value: unknown): string | undefined => typeof value === 'string' ? descriptors.find(item =>
      item.id.toLowerCase() === value.toLowerCase() || item.displayName.toLowerCase() === value.toLowerCase())?.id : undefined
    const namedSource = canonicalSource(current.dataSource)
    const metadataSource = canonicalSource(previous?.source)
    if (current.dataSource && !namedSource) return null
    if (previous?.source && !metadataSource) return null
    if (namedSource && metadataSource && namedSource !== metadataSource) return null
    let parsed: ImportIdentity | undefined
    if (current.dataSourceUrl) {
      for (const item of descriptors) {
        try {
          const sourceId = registry.get(item.id).parseSourceUrl(current.dataSourceUrl)
          if (typeof sourceId === 'string' && sourceId) { parsed = { source: item.id, sourceId }; break }
        } catch { /* A saved URL is not necessarily owned by this source. */ }
      }
      if (!parsed || (namedSource && parsed.source !== namedSource) || (metadataSource && parsed.source !== metadataSource)) return null
    }
    if (previous?.sourceId !== undefined) {
      if (typeof previous.sourceId !== 'string' || !previous.sourceId || !metadataSource) return null
      if (parsed && parsed.sourceId !== previous.sourceId) return null
      return { source: metadataSource, sourceId: previous.sourceId }
    }
    return parsed ?? null
  }
  const validateIdentity = (draft: MediaDraft): MediaDraft => {
    const crawler = select(draft.dataSource)
    const identity = draft.attribute.metadata
    if (descriptor(crawler).id !== identity.source || identity.source !== draft.dataSource) {
      throw new CrawlerError('INVALID_INPUT', draft.dataSource, '来源身份不一致')
    }
    const sourceId = crawler.parseSourceUrl(draft.dataSourceUrl)
    if (sourceId !== identity.sourceId) throw new CrawlerError('INVALID_INPUT', draft.dataSource, '来源链接与条目 ID 不一致')
    return { ...draft, dataSourceUrl: crawler.getSourceUrl(sourceId) }
  }
  return {
    sources(): CrawlerDescriptor[] { return registry.list() },
    async search(body: unknown, { signal }: CrawlerContext = {}): Promise<SearchResult> {
      const input = bodyFields(body, {
        source: sourceName, keyword: text('搜索关键词', 200), mediaType: text('媒体类型', 32),
        year: value => number(value, '年份', 1000, 9999),
        limit: value => number(value, '候选数量', 1, 10), offset: value => number(value, '分页位置', 0, 10_000_000),
      }, { mediaType: 'anime', limit: 5, offset: 0 }, ['source', 'keyword'])
      const { source, ...params } = input
      checkCancelled(signal, source)
      const result = await select(source).search(params, { signal })
      checkCancelled(signal, source)
      return result
    },
    async preview(body: unknown, { signal }: CrawlerContext = {}): Promise<MediaDraft> {
      const { source, ...params } = bodyFields(body, {
        source: sourceName, sourceId: text('来源条目 ID', 1000), url: text('来源链接', 8192),
      }, {}, ['source'])
      if (Object.hasOwn(params, 'sourceId') === Object.hasOwn(params, 'url')) {
        throw new CrawlerError('INVALID_INPUT', source, '来源条目 ID 与链接必须且只能提供一个')
      }
      checkCancelled(signal, source)
      // contracts.ts re-validates the crawler payload at runtime.
      const draft = validateMediaDraft(await select(source).fetch(params, { signal }), { source })
      checkCancelled(signal, source)
      try { return validateIdentity(draft) }
      catch { throw new CrawlerError('INVALID_RESULT', source, '来源返回的条目身份无效') }
    },
    apply(mediaId: unknown, body: unknown, { signal }: CrawlerContext = {}): Media | null {
      checkCancelled(signal)
      const options = metadataImportOptions(body)
      let draft: MediaDraft
      try { draft = validateMediaDraft(options.metadata) }
      catch (error) {
        if ((error as { code?: string }).code === 'INVALID_RESULT') throw new CrawlerError('INVALID_INPUT', NO_SOURCE, '导入的媒体草稿无效')
        throw error
      }
      try { draft = validateIdentity(draft) }
      catch (error) {
        if ((error as { code?: string }).code === 'INVALID_RESULT') throw new CrawlerError('INVALID_INPUT', draft.dataSource, '导入的来源身份无效')
        throw error
      }
      checkCancelled(signal, draft.dataSource)
      return catalogService.importMetadata(mediaId, { ...options, metadata: draft }, { signal, resolveIdentity })
    },
  }
}
