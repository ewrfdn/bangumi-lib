import { createHttpClient } from './http-client.ts'
import { CrawlerError } from './crawler-error.ts'
import { isRecord, validateMediaDraft, validateSearchResult } from './contracts.ts'
import type { CrawlerHttpClient, CrawlerRequestOptions, FetchLike, HttpClientFactory } from './http-client.ts'
import type { MediaDraft, SearchResult } from './contracts.ts'
import type { CrawlerSourceConfig, Logger } from '../types.ts'
import type { Dispatcher } from 'undici'

/** Source description published by the registry; contains no connection secrets. */
export interface CrawlerDescriptor {
  id: string
  displayName: string
  mediaTypes: string[]
  supportsYearFilter: boolean
  supportsOffset: boolean
}

/** Capabilities a source declares; the base class copies and freezes the lists. */
export interface CrawlerCapabilities {
  id: string
  displayName: string
  mediaTypes: string[]
  supportsYearFilter: boolean
  supportsOffset: boolean
  allowedOrigins: string[]
  imageOrigins: string[]
}

/** Normalized capabilities held by a live crawler instance. */
export interface ResolvedCrawlerCapabilities {
  readonly id: string
  readonly displayName: string
  readonly mediaTypes: readonly string[]
  readonly supportsYearFilter: boolean
  readonly supportsOffset: boolean
  readonly allowedOrigins: readonly string[]
  readonly imageOrigins: readonly string[]
}

/** Injected collaborators; all of them are optional in production. */
export interface CrawlerDependencies {
  logger?: Logger
  now?: () => number
  httpClient?: CrawlerHttpClient
  httpClientFactory?: HttpClientFactory
  fetchImpl?: FetchLike
  dispatcher?: Dispatcher
}

/** Source config with the resolved operation budget. */
export interface CrawlerRuntimeConfig extends Partial<CrawlerSourceConfig> {
  operationTimeoutMs: number
}

/** Raw search input accepted from the metadata service; validated in `search`. */
export type CrawlerSearchParams = {
  keyword: string
  mediaType?: string
  year?: number
  limit?: number
  offset?: number
}

/** Raw detail input accepted from the metadata service; validated in `fetch`. */
export type CrawlerFetchParams = {
  sourceId?: string
  url?: string
}

/** Validated search query handed to a source implementation. */
export interface CrawlerSearchQuery {
  keyword: string
  mediaType: string
  year?: number
  limit: number
  offset: number
}

/** Per-operation cancellation context handed to a source implementation. */
export interface CrawlerOperationContext {
  signal: AbortSignal
}

/** Optional per-call cancellation signal. */
export interface CrawlerOperationOptions {
  signal?: AbortSignal
}

export class BaseCrawler {
  readonly capabilities: ResolvedCrawlerCapabilities
  readonly id: string
  readonly enabled: boolean
  readonly config: CrawlerRuntimeConfig
  readonly logger: Logger | undefined
  readonly now: () => number
  readonly httpClient: CrawlerHttpClient
  closed: boolean
  readonly operations: Set<AbortController>

  constructor(
    config: Partial<CrawlerSourceConfig> = {},
    dependencies: CrawlerDependencies = {},
    // The base class is only instantiated through a source that declares its identity.
    capabilities: CrawlerCapabilities = {} as CrawlerCapabilities,
  ) {
    this.capabilities = Object.freeze({
      ...capabilities,
      mediaTypes: Object.freeze([...(capabilities.mediaTypes ?? [])]),
      imageOrigins: Object.freeze([...(capabilities.imageOrigins ?? [])]),
    })
    this.id = this.capabilities.id
    this.enabled = config.enabled !== false
    this.config = { ...config, operationTimeoutMs: config.operationTimeoutMs ?? 35000 }
    if (!Number.isSafeInteger(this.config.operationTimeoutMs) || this.config.operationTimeoutMs < 1 || this.config.operationTimeoutMs > 300000) throw new CrawlerError('INVALID_INPUT', this.id, '操作总超时配置无效')
    this.logger = dependencies.logger
    this.now = dependencies.now ?? Date.now
    this.closed = false
    this.operations = new Set<AbortController>()
    const factory: HttpClientFactory = dependencies.httpClientFactory ?? createHttpClient
    this.httpClient = dependencies.httpClient ?? factory(this.config, { source: this.id, allowedOrigins: capabilities.allowedOrigins ?? [], fetchImpl: dependencies.fetchImpl, dispatcher: dependencies.dispatcher, logger: this.logger })
  }

  describe(): CrawlerDescriptor {
    const { id, displayName, mediaTypes, supportsYearFilter, supportsOffset } = this.capabilities
    return { id, displayName, mediaTypes: [...mediaTypes], supportsYearFilter, supportsOffset }
  }

  async search(params: CrawlerSearchParams, options: CrawlerOperationOptions = {}): Promise<SearchResult> {
    const { signal } = options
    return this.run(async (context): Promise<SearchResult> => {
      if (!isRecord(params)) this.invalid('搜索参数必须为对象')
      const input: CrawlerSearchParams = params
      if (Object.keys(input).some(key => !['keyword', 'mediaType', 'year', 'limit', 'offset'].includes(key))) throw new CrawlerError('UNSUPPORTED_FILTER', this.id, '不支持该搜索筛选条件')
      const { keyword, mediaType = 'anime', year, limit = 5, offset = 0 } = input
      if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 200 || keyword.includes('\0')) this.invalid('搜索关键词无效')
      if (!this.capabilities.mediaTypes.includes(mediaType)) throw new CrawlerError('UNSUPPORTED_FILTER', this.id, '不支持该媒体类型')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) this.invalid('搜索分页参数无效')
      if (year !== undefined && (!Number.isInteger(year) || year < 1000 || year > 9999)) this.invalid('年份必须为四位整数')
      if (year !== undefined && !this.capabilities.supportsYearFilter) throw new CrawlerError('UNSUPPORTED_FILTER', this.id, '该来源不支持年份筛选')
      if (offset && !this.capabilities.supportsOffset) throw new CrawlerError('UNSUPPORTED_FILTER', this.id, '该来源不支持分页偏移')
      const result = validateSearchResult(await this._search({ keyword: keyword.trim(), mediaType, year, limit, offset }, context), { source: this.id, limit, offset, logger: this.logger })
      for (const candidate of result.items) {
        let candidateId: string
        try { candidateId = this.parseSourceUrl(candidate.sourceUrl) }
        catch { throw new CrawlerError('INVALID_RESULT', this.id, '搜索候选来源链接无效') }
        if (candidateId !== candidate.sourceId) throw new CrawlerError('INVALID_RESULT', this.id, '搜索候选来源身份不一致')
      }
      return result
    }, signal)
  }

  async fetch(params: CrawlerFetchParams, options: CrawlerOperationOptions = {}): Promise<MediaDraft> {
    const { signal } = options
    return this.run(async (context): Promise<MediaDraft> => {
      if (!isRecord(params) || Object.keys(params).some(key => !['sourceId', 'url'].includes(key))) this.invalid('详情参数无效')
      const input: CrawlerFetchParams = params
      const hasId = Object.hasOwn(input, 'sourceId'), hasUrl = Object.hasOwn(input, 'url')
      if (hasId === hasUrl) this.invalid('sourceId 与 url 必须且只能提供一个')
      const sourceId = hasId ? input.sourceId : this.parseSourceUrl(input.url)
      if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 1000 || sourceId.includes('\0')) this.invalid('来源条目ID无效')
      // getSourceUrl performs source-specific identifier validation before any request.
      const expectedUrl = this.getSourceUrl(sourceId)
      const result = validateMediaDraft(await this._fetch(sourceId, context), { source: this.id, logger: this.logger })
      let resultId: string
      try { resultId = this.parseSourceUrl(result.dataSourceUrl) }
      catch { throw new CrawlerError('INVALID_RESULT', this.id, '来源返回的条目链接无效') }
      if (result.attribute.metadata.sourceId !== sourceId || resultId !== sourceId || result.dataSourceUrl !== expectedUrl) throw new CrawlerError('INVALID_RESULT', this.id, '来源条目身份与请求不一致')
      return result
    }, signal)
  }

  invalid(message: string): never { throw new CrawlerError('INVALID_INPUT', this.id, message) }

  async run<T>(operation: (context: CrawlerOperationContext) => T | Promise<T>, userSignal?: AbortSignal): Promise<T> {
    if (this.closed) throw new CrawlerError('CANCELLED', this.id, '来源已关闭')
    if (!this.enabled) throw new CrawlerError('SOURCE_DISABLED', this.id, '该来源未启用')
    if (userSignal !== undefined && (!(userSignal instanceof AbortSignal))) this.invalid('取消信号无效')
    const controller = new AbortController()
    this.operations.add(controller)
    const cancel = (): void => controller.abort(new CrawlerError('CANCELLED', this.id, '操作已取消'))
    if (userSignal?.aborted) cancel()
    else userSignal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(() => controller.abort(new CrawlerError('TIMEOUT', this.id, '操作超过总时间限制')), this.config.operationTimeoutMs)
    let abortListener!: () => void
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abortListener, { once: true })
      if (controller.signal.aborted) abortListener()
    })
    try {
      return await Promise.race([aborted, Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return operation({ signal: controller.signal })
      })])
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      if (error instanceof CrawlerError) throw error
      throw new CrawlerError('PARSE_ERROR', this.id, '来源数据处理失败')
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', abortListener)
      userSignal?.removeEventListener('abort', cancel)
      this.operations.delete(controller)
    }
  }

  requestJson(url: string | URL, options?: CrawlerRequestOptions): Promise<any> { return this.httpClient.requestJson(url, options) }
  requestText(url: string | URL, options?: CrawlerRequestOptions): Promise<string> { return this.httpClient.requestText(url, options) }

  /** 图片只能从来源声明的图片域名读取，避免任意 URL 借图片通道取数据。 */
  requestImage(url: string, options: CrawlerRequestOptions = {}): Promise<Buffer> {
    let parsed: URL
    try { parsed = new URL(url) } catch { this.invalid('图片地址无效') }
    if (!this.capabilities.imageOrigins.includes(parsed.origin)) throw new CrawlerError('ACCESS_DENIED', this.id, '图片地址不在允许的来源范围内')
    return this.httpClient.requestBuffer(url, { ...options, method: 'GET' })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const operation of this.operations) operation.abort(new CrawlerError('CANCELLED', this.id, '来源已关闭'))
    await this.httpClient.close()
  }
}

/** Source-specific hooks implemented by concrete crawlers. */
export interface BaseCrawler {
  _search(query: CrawlerSearchQuery, context: CrawlerOperationContext): Promise<SearchResult>
  _fetch(sourceId: string, context: CrawlerOperationContext): Promise<MediaDraft>
  parseSourceUrl(value: unknown): string
  getSourceUrl(sourceId: string): string
}

export default BaseCrawler
