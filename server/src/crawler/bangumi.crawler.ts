import { BaseCrawler } from './base.crawler.ts'
import { CrawlerError } from './crawler-error.ts'
import { isHttpUrl, isRecord, isValidDate } from './contracts.ts'
import type { JsonRecord, MediaDraft, MediaDraftMetadata, SearchCandidate, SearchResult } from './contracts.ts'
import type { CrawlerDependencies, CrawlerOperationContext, CrawlerSearchQuery } from './base.crawler.ts'
import type { CrawlerSourceConfig } from '../types.ts'

const API = 'https://api.bgm.tv'
const IMAGES = 'https://lain.bgm.tv'
const pageHosts = new Set(['bgm.tv', 'bangumi.tv', 'chii.in'])

/** Clean optional upstream text; blank or NUL-containing values are dropped. */
const clean = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() && !value.includes('\0') ? value.trim() : undefined
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value) && Number.isSafeInteger(Number(value))
const positiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
/** Drop junk entries from optional upstream lists while keeping first-seen order. */
const present = (value: string | undefined): value is string => Boolean(value)

/** Identity a validated Bangumi subject publishes to the rest of the crawler. */
interface BangumiSubjectIdentity {
  sourceId: string
  title: string
  originalTitle?: string
}

export class BangumiCrawler extends BaseCrawler {
  constructor(config: Partial<CrawlerSourceConfig> = {}, dependencies: CrawlerDependencies = {}) {
    const sourceConfig: Partial<CrawlerSourceConfig> = { userAgent: 'anishare/bangumi-lib/0.1', ...config }
    if (typeof sourceConfig.userAgent !== 'string' || !/^[\x20-\x7e]{1,500}$/.test(sourceConfig.userAgent) || (sourceConfig.token !== undefined && (typeof sourceConfig.token !== 'string' || !/^[\x20-\x7e]{0,8192}$/.test(sourceConfig.token)))) throw new CrawlerError('INVALID_INPUT', 'bangumi', 'Bangumi 请求头配置无效')
    super(sourceConfig, dependencies, { id: 'bangumi', displayName: 'Bangumi 番组计划', mediaTypes: ['anime'], supportsYearFilter: true, supportsOffset: true, allowedOrigins: [API, IMAGES], imageOrigins: [IMAGES] })
  }

  parseSourceUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 8192 || value !== value.trim() || /[\\\s]/.test(value) || !/^https?:\/\/[^/?#]+\/subject\/[1-9]\d*\/?$/i.test(value)) this.invalid('Bangumi 条目链接无效')
    let url: URL
    try { url = new URL(value) } catch { this.invalid('Bangumi 条目链接无效') }
    if (!['https:', 'http:'].includes(url.protocol) || !pageHosts.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash) this.invalid('只支持 Bangumi 的标准条目页面链接')
    const match = /^\/subject\/([1-9]\d{0,14})\/?$/.exec(url.pathname)
    if (!match || !validId(match[1])) this.invalid('Bangumi 条目链接无效')
    return match[1]
  }

  getSourceUrl(sourceId: string): string {
    if (!validId(sourceId)) this.invalid('Bangumi 条目ID必须为正整数字符串')
    return `https://bgm.tv/subject/${sourceId}`
  }

  headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.config.userAgent) headers['User-Agent'] = this.config.userAgent
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`
    return headers
  }

  sourceResult(message: string): never { throw new CrawlerError('INVALID_RESULT', this.id, message) }

  coverOf(subject: JsonRecord): string | undefined {
    if (!isRecord(subject.images)) return undefined
    for (const size of ['large', 'common', 'medium', 'small', 'grid']) {
      if (isHttpUrl(subject.images[size])) return subject.images[size]
    }
    return undefined
  }

  subjectIdentity(subject: unknown): BangumiSubjectIdentity {
    if (!isRecord(subject) || !positiveInt(subject.id) || !validId(String(subject.id)) || subject.type !== 2) this.sourceResult('Bangumi 返回的动画条目身份无效')
    const originalTitle = clean(subject.name), title = clean(subject.name_cn) ?? originalTitle
    if (!title) this.sourceResult('Bangumi 条目缺少有效标题')
    return { sourceId: String(subject.id), title, originalTitle }
  }

  async _search({ keyword, year, limit, offset }: CrawlerSearchQuery, { signal }: CrawlerOperationContext): Promise<SearchResult> {
    const filter: { type: number[]; air_date?: string[] } = { type: [2] }
    if (year !== undefined) filter.air_date = [`>=${year}-01-01`, year === 9999 ? '<=9999-12-31' : `<${year + 1}-01-01`]
    const response = await this.requestJson(`${API}/v0/search/subjects?limit=${limit}&offset=${offset}`, { method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword, sort: 'match', filter }), signal, retryable: true })
    if (!isRecord(response) || !Array.isArray(response.data) || response.data.length > limit || (response.total !== undefined && response.total !== null && (!Number.isSafeInteger(response.total) || response.total < 0))) this.sourceResult('Bangumi 搜索结果结构无效')
    return {
      items: response.data.map((subject: JsonRecord): SearchCandidate => {
        const identity = this.subjectIdentity(subject)
        const result: SearchCandidate = { source: this.id, sourceId: identity.sourceId, sourceUrl: this.getSourceUrl(identity.sourceId), title: identity.title, mediaType: 'anime', cover: this.coverOf(subject) ?? null, airedOn: isValidDate(subject.date) ? subject.date : null, platform: clean(subject.platform) ?? null }
        if (identity.originalTitle) result.originalTitle = identity.originalTitle
        return result
      }),
      total: response.total ?? null,
      limit,
      offset,
    }
  }

  async _fetch(sourceId: string, { signal }: CrawlerOperationContext): Promise<MediaDraft> {
    const subject: JsonRecord = await this.requestJson(`${API}/v0/subjects/${sourceId}`, { headers: this.headers(), signal, retryable: true })
    const identity = this.subjectIdentity(subject)
    if (identity.sourceId !== sourceId) this.sourceResult('Bangumi 返回的条目ID与请求不一致')
    const metadata: MediaDraftMetadata = { source: this.id, sourceId, fetchedAt: this.now() }
    if (identity.originalTitle) metadata.originalTitle = identity.originalTitle
    if (clean(subject.platform)) metadata.platform = clean(subject.platform)
    const aliasBox: JsonRecord | undefined = Array.isArray(subject.infobox) ? subject.infobox.find((entry: JsonRecord): boolean => isRecord(entry) && entry.key === '别名') : undefined
    if (aliasBox) {
      const singleAlias = typeof aliasBox.value === 'string' ? clean(aliasBox.value) : undefined
      if (singleAlias) metadata.aliases = [singleAlias]
      else if (Array.isArray(aliasBox.value)) {
        const aliases = [...new Set(aliasBox.value.map((alias: unknown) => typeof alias === 'string' ? clean(alias) : isRecord(alias) ? clean(alias.v) : undefined).filter(present))]
        if (aliases.length || aliasBox.value.length === 0) metadata.aliases = aliases
      }
    }
    const result: MediaDraft = { title: identity.title, mediaType: 'anime', dataSource: this.id, dataSourceUrl: this.getSourceUrl(sourceId), attribute: { metadata } }
    const cover = this.coverOf(subject)
    if (cover) result.cover = cover
    if (positiveInt(subject.eps) && subject.eps <= 100000) result.episodeCount = subject.eps
    if (clean(subject.summary)) result.description = clean(subject.summary)
    if (isValidDate(subject.date)) result.airedOn = subject.date
    if (isRecord(subject.rating) && positiveInt(subject.rating.total) && Number.isFinite(subject.rating.score) && subject.rating.score >= 0 && subject.rating.score <= 10) result.rating = subject.rating.score
    if (Array.isArray(subject.tags)) {
      const tags = [...new Set(subject.tags.map((tag: unknown) => isRecord(tag) ? clean(tag.name) : undefined).filter(present))]
      if (tags.length || subject.tags.length === 0) result.tags = tags
    }
    return result
  }
}

export default BangumiCrawler
