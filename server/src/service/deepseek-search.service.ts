import type { Logger } from '../types.ts'
import type { SearchRuntimeConfig, SearchSettingsService } from './search-settings.service.ts'

/** DeepSeek Search API 单条结果（字段见官方 /v1/tools/search 响应）。 */
export interface SearchResultItem {
  title: string
  url: string
  snippet: string
  summary: string
  content: string
  siteName: string | null
  date: string | null
  authority: number | null
  score: number | null
}

export interface SearchResponse {
  query: string
  /** 实际返回条数（可能少于请求条数）。 */
  count: number
  results: SearchResultItem[]
}

export interface FetchPageResponse {
  url: string
  title: string
  content: string
}

export interface SearchTestResult {
  ok: true
  provider: 'deepseek'
  latencyMs: number
  query: string
  count: number
  sample: Array<{ title: string; url: string }>
}

export interface DeepSeekSearchService {
  search(query: string, options?: { count?: number; needContent?: boolean; signal?: AbortSignal }): Promise<SearchResponse>
  fetchPage(url: string, options?: { signal?: AbortSignal }): Promise<FetchPageResponse>
  /** 后台「测试搜索」：使用当前保存配置 + 传入草稿，发一次最小请求验证连通性。 */
  test(draft?: unknown, options?: { signal?: AbortSignal }): Promise<SearchTestResult>
}

export interface DeepSeekSearchDependencies {
  settings: SearchSettingsService
  logger?: Logger
  /** 便于单测注入；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch
}

const QUERY_MAX_CHARS = 128
const URL_MAX_CHARS = 8192
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024
const CONTENT_MAX_CHARS = 200_000
const SUMMARY_MAX_CHARS = 2000
const SNIPPET_MAX_CHARS = 600
const TITLE_MAX_CHARS = 400

type SearchFailureCode =
  | 'SEARCH_QUERY_INVALID'
  | 'SEARCH_URL_INVALID'
  | 'SEARCH_TIMEOUT'
  | 'SEARCH_ABORTED'
  | 'SEARCH_AUTH_FAILED'
  | 'SEARCH_RATE_LIMITED'
  | 'SEARCH_UPSTREAM_UNAVAILABLE'
  | 'SEARCH_UPSTREAM_REJECTED'
  | 'SEARCH_UPSTREAM_INVALID'

const FAILURE_STATUS: Record<SearchFailureCode, number> = {
  SEARCH_QUERY_INVALID: 400,
  SEARCH_URL_INVALID: 400,
  SEARCH_TIMEOUT: 504,
  SEARCH_ABORTED: 499,
  SEARCH_AUTH_FAILED: 400,
  SEARCH_RATE_LIMITED: 429,
  SEARCH_UPSTREAM_UNAVAILABLE: 502,
  SEARCH_UPSTREAM_REJECTED: 502,
  SEARCH_UPSTREAM_INVALID: 502,
}

const failure = (code: SearchFailureCode, message: string): Error =>
  Object.assign(new Error(message), { status: FAILURE_STATUS[code], code })

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max)}…` : value
const textOf = (value: unknown, max: number): string => typeof value === 'string' ? clip(value, max) : ''
const numberOrNull = (value: unknown, min: number, max: number): number | null => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : null
  return parsed === null ? null : Math.min(max, Math.max(min, parsed))
}

/** 搜索关键词按 Unicode 字符计数，1–128 个字符且不能全是空白。 */
function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string') throw failure('SEARCH_QUERY_INVALID', '搜索关键词不能为空')
  const query = value.trim()
  const length = [...query].length
  if (!query) throw failure('SEARCH_QUERY_INVALID', '搜索关键词不能为空')
  if (length > QUERY_MAX_CHARS) throw failure('SEARCH_QUERY_INVALID', `搜索关键词最多 ${QUERY_MAX_CHARS} 个字符`)
  return query
}

/** Fetch API 只接受匿名 http/https 链接，长度上限 8192。 */
function normalizeFetchUrl(value: unknown): string {
  if (typeof value !== 'string') throw failure('SEARCH_URL_INVALID', '网页链接不能为空')
  const url = value.trim()
  if (!url || url.length > URL_MAX_CHARS) throw failure('SEARCH_URL_INVALID', '网页链接无效或过长')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw failure('SEARCH_URL_INVALID', '网页链接必须是有效的 HTTP 或 HTTPS 地址') }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host || parsed.username || parsed.password) {
    throw failure('SEARCH_URL_INVALID', '网页链接必须是匿名的 HTTP 或 HTTPS 地址')
  }
  return parsed.toString()
}

function endpointOf(config: SearchRuntimeConfig, path: string): string {
  const base = config.baseUrl.replace(/\/+$/, '')
  return `${base}${base.endsWith('/v1') ? '' : '/v1'}${path}`
}

/** 上游错误正文只用于诊断，截断并去掉换行，避免把大段 HTML 透给前端或模型。 */
function describeUpstream(payload: unknown): string {
  const record = isRecord(payload) ? payload : {}
  const error = isRecord(record.error) ? record.error : {}
  const message = typeof error.message === 'string' ? error.message : typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : ''
  return message.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function mapResult(value: unknown): SearchResultItem | null {
  if (!isRecord(value)) return null
  const url = textOf(value.url, URL_MAX_CHARS)
  if (!/^https?:\/\//i.test(url)) return null
  return {
    title: textOf(value.title, TITLE_MAX_CHARS),
    url,
    snippet: textOf(value.snippet, SNIPPET_MAX_CHARS),
    summary: textOf(value.summary, SUMMARY_MAX_CHARS),
    content: textOf(value.content, CONTENT_MAX_CHARS),
    siteName: value.site_name === null || value.site_name === undefined ? null : textOf(value.site_name, 200) || null,
    date: value.date === null || value.date === undefined ? null : textOf(value.date, 64) || null,
    authority: numberOrNull(value.authority, -1, 4),
    score: numberOrNull(value.rerank_score, 0, 3),
  }
}

function mapResults(payload: unknown): SearchResultItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw failure('SEARCH_UPSTREAM_INVALID', '搜索接口返回了无法识别的数据')
  }
  return payload.results.map(mapResult).filter((item): item is SearchResultItem => item !== null)
}

export function createDeepSeekSearchService({ settings, logger, fetchImpl }: DeepSeekSearchDependencies): DeepSeekSearchService {
  const request = fetchImpl || globalThis.fetch
  const postJson = async (config: SearchRuntimeConfig, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      const response = await request(endpointOf(config, path), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: linked,
      })
      const text = await response.text()
      if (text.length > RESPONSE_MAX_BYTES) throw failure('SEARCH_UPSTREAM_INVALID', '搜索接口返回内容过大')
      let payload: unknown = null
      if (text) {
        try { payload = JSON.parse(text) } catch { payload = null }
      }
      if (!response.ok) {
        const detail = describeUpstream(payload)
        if (response.status === 401 || response.status === 403) {
          throw failure('SEARCH_AUTH_FAILED', 'DeepSeek 搜索密钥无效或没有 Search / Fetch API 权限，请检查 API Key')
        }
        if (response.status === 429) throw failure('SEARCH_RATE_LIMITED', 'DeepSeek 搜索接口触发限流，请稍后重试')
        if (response.status >= 500) throw failure('SEARCH_UPSTREAM_UNAVAILABLE', 'DeepSeek 搜索服务暂时不可用，请稍后重试')
        throw failure('SEARCH_UPSTREAM_REJECTED', `搜索请求被拒绝${detail ? `：${detail}` : `（HTTP ${response.status}）`}`)
      }
      if (payload === null) throw failure('SEARCH_UPSTREAM_INVALID', '搜索接口返回了无法识别的数据')
      return payload
    } catch (error) {
      if (error && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('SEARCH_')) throw error
      if (signal?.aborted) throw failure('SEARCH_ABORTED', '联网搜索已取消')
      if (controller.signal.aborted) throw failure('SEARCH_TIMEOUT', `联网搜索超时（超过 ${Math.round(config.timeoutMs / 1000)} 秒）`)
      throw failure('SEARCH_UPSTREAM_UNAVAILABLE', '无法连接 DeepSeek 搜索服务，请检查网络或 API 地址')
    } finally {
      clearTimeout(timer)
    }
  }

  const searchWith = async (config: SearchRuntimeConfig, query: string, options: { count?: number; needContent?: boolean; signal?: AbortSignal } = {}): Promise<SearchResponse> => {
    const normalized = normalizeQuery(query)
    const count = Math.min(50, Math.max(1, Number.isInteger(options.count) ? (options.count as number) : config.count))
    const needContent = typeof options.needContent === 'boolean' ? options.needContent : config.needContent
    const payload = await postJson(config, '/tools/search', { query: normalized, count, need_content: needContent }, options.signal)
    const results = mapResults(payload)
    return { query: normalized, count: results.length, results }
  }

  const fetchWith = async (config: SearchRuntimeConfig, url: string, options: { signal?: AbortSignal } = {}): Promise<FetchPageResponse> => {
    const normalized = normalizeFetchUrl(url)
    const payload = await postJson(config, '/tools/fetch', { url: normalized }, options.signal)
    if (!isRecord(payload)) throw failure('SEARCH_UPSTREAM_INVALID', '网页抓取接口返回了无法识别的数据')
    return {
      url: normalized,
      title: textOf(payload.title, TITLE_MAX_CHARS),
      content: textOf(payload.content, CONTENT_MAX_CHARS),
    }
  }

  return {
    async search(query, options = {}) {
      return searchWith(settings.effective(), query, options)
    },
    async fetchPage(url, options = {}) {
      return fetchWith(settings.effective(), url, options)
    },
    async test(draft = {}, { signal } = {}) {
      const config = settings.draft(draft)
      const started = Date.now()
      const response = await searchWith(config, 'AniShare 个人媒体库', { count: 1, needContent: false, signal })
      return {
        ok: true,
        provider: 'deepseek',
        latencyMs: Date.now() - started,
        query: response.query,
        count: response.count,
        sample: response.results.slice(0, 2).map((item) => ({ title: item.title, url: item.url })),
      }
    },
  }
}
