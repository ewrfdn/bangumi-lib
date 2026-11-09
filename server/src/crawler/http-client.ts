import { Agent, Headers, ProxyAgent, fetch } from 'undici'
import type { BodyInit, Dispatcher, HeadersInit, RequestInit, Response } from 'undici'
import { CrawlerError } from './crawler-error.ts'
import type { CrawlerErrorOptions } from './crawler-error.ts'
import type { Logger } from '../types.ts'

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504])
const SAFE_REDIRECT_HEADERS = new Set(['accept', 'accept-language', 'user-agent'])

/** Per-source transport limits; every field falls back to a validated default. */
export interface HttpClientConfig {
  proxyUrl?: string | null
  userAgent?: string
  timeoutMs?: number
  maxRetries?: number
  minIntervalMs?: number
  concurrency?: number
  maxBodyBytes?: number
  maxRedirects?: number
  maxRetryDelayMs?: number
}

/** Injected transport collaborators; the source owns everything else. */
export interface HttpClientDependencies {
  source?: string
  allowedOrigins?: readonly string[]
  fetchImpl?: FetchLike
  dispatcher?: Dispatcher
  logger?: Logger
}

/** Adapter shape used in place of undici's `fetch` (tests and projections). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Options accepted by every request helper below. */
export interface CrawlerRequestOptions {
  method?: string
  headers?: HeadersInit
  body?: BodyInit | null
  signal?: AbortSignal
  retryable?: boolean
}

/** Client handed to a crawler; one instance per source, closed with the source. */
export interface CrawlerHttpClient {
  requestText(url: string | URL, options?: CrawlerRequestOptions): Promise<string>
  requestBuffer(url: string | URL, options?: CrawlerRequestOptions): Promise<Buffer>
  /**
   * JSON boundary: the parsed body is untrusted upstream JSON. Callers must
   * revalidate it through `contracts.ts` before reading any field.
   */
  requestJson(url: string | URL, options?: CrawlerRequestOptions): Promise<any>
  close(): Promise<void>
}

/** Injection point so tests and callers can replace transport construction. */
export type HttpClientFactory = (config: HttpClientConfig, dependencies: HttpClientDependencies) => CrawlerHttpClient

/** Config keys validated as bounded safe integers. */
type HttpIntegerKey = 'timeoutMs' | 'maxRetries' | 'minIntervalMs' | 'concurrency' | 'maxBodyBytes' | 'maxRedirects' | 'maxRetryDelayMs'

/** Accumulated body segments plus their declared byte count. */
interface ReadChunksResult {
  buffers: Buffer[]
  size: number
}

type ReadFunction<T> = (response: Response, signal: AbortSignal) => Promise<T>

/** Queued request slot awaiting its start interval. */
interface PendingRequest {
  readonly signal: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (reason?: unknown) => void
  readonly onAbort: () => void
}

/** Third-party boundary: Node/undici transport failures have no stable type. */
interface TransportFailure {
  code: string
  message: string
  hostname?: string
  syscall?: string
  port?: string | number
  cause?: TransportFailure
}

/** A source owns its dispatcher, queue and retry policy; no process-wide proxy state. */
export function createHttpClient(config: HttpClientConfig = {}, {
  source = 'unknown', allowedOrigins = [], fetchImpl = fetch, dispatcher: providedDispatcher, logger,
}: HttpClientDependencies = {}): CrawlerHttpClient {
  const error = (code: string, message: string, options?: CrawlerErrorOptions): CrawlerError =>
    new CrawlerError(code, source, message, options)
  const integer = (key: HttpIntegerKey, fallback: number, minimum: number, maximum: number): number => {
    const value = config[key] ?? fallback
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw error('INVALID_INPUT', `爬取配置 ${key} 无效`)
    }
    return value
  }
  const timeoutMs = integer('timeoutMs', 10000, 1, 120000)
  const maxRetries = integer('maxRetries', 1, 0, 3)
  const minIntervalMs = integer('minIntervalMs', 500, 0, 60000)
  const concurrency = integer('concurrency', 1, 1, 10)
  const maxBodyBytes = integer('maxBodyBytes', 2 * 1024 * 1024, 1, 16 * 1024 * 1024)
  const maxRedirects = integer('maxRedirects', 3, 0, 10)
  const maxRetryDelayMs = integer('maxRetryDelayMs', 5000, 0, 60000)
  let origins: Set<string>
  try {
    if (!Array.isArray(allowedOrigins) || !allowedOrigins.length) throw new Error()
    origins = new Set(allowedOrigins.map((value: string): string => {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash) throw new Error()
      return url.origin
    }))
  } catch { throw error('INVALID_INPUT', '爬取源必须配置有效的请求来源白名单') }
  if (typeof fetchImpl !== 'function') throw error('INVALID_INPUT', '请求适配器无效')
  let proxyUrl: URL | undefined
  if (config.proxyUrl) {
    try {
      proxyUrl = new URL(config.proxyUrl)
      if (!['http:', 'https:'].includes(proxyUrl.protocol) || proxyUrl.pathname !== '/' ||
          proxyUrl.search || proxyUrl.hash) throw new Error()
    } catch { throw error('INVALID_INPUT', '代理地址必须使用 HTTP 或 HTTPS 协议') }
  }
  function createDispatcher(): Dispatcher {
    try {
      // ProxyAgent's published type omits `URL`, but it accepts and normalizes one at runtime.
      return proxyUrl ? new ProxyAgent(proxyUrl.href) : new Agent()
    } catch { throw error('INVALID_INPUT', '无法创建爬取源的网络连接') }
  }
  const dispatcher: Dispatcher = providedDispatcher ?? createDispatcher()

  const closing = new AbortController()
  const pending: PendingRequest[] = []
  let active = 0
  let nextStartAt = 0
  let queueTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let closePromise: Promise<void> | undefined

  const aborted = (signal: AbortSignal): CrawlerError => {
    if (signal.reason instanceof CrawlerError) return signal.reason
    return signal.reason?.name === 'TimeoutError'
      ? error('TIMEOUT', '数据源请求超时', { retryable: true })
      : error('CANCELLED', '数据源请求已取消')
  }
  const assertActive = (signal: AbortSignal): void => { if (signal.aborted) throw aborted(signal) }
  const abortable = <T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
    const settled = (value: T): void => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const failed = (reason: unknown): void => {
      signal.removeEventListener('abort', onAbort)
      reject(reason)
    }
    const onAbort = (): void => failed(aborted(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    // Always observe the underlying promise, even if a synchronous adapter aborted.
    Promise.resolve(promise).then(settled, failed)
    if (signal.aborted) onAbort()
  })
  const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(aborted(signal)); return }
    const onAbort = (): void => { clearTimeout(timer); reject(aborted(signal)) }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  function drain(): void {
    clearTimeout(queueTimer)
    queueTimer = undefined
    while (pending.length && active < concurrency) {
      const wait = nextStartAt - Date.now()
      if (wait > 0) { queueTimer = setTimeout(drain, wait); return }
      const item = pending.shift()
      if (!item) return
      item.signal.removeEventListener('abort', item.onAbort)
      if (item.signal.aborted) { item.reject(aborted(item.signal)); continue }
      active++
      nextStartAt = Date.now() + minIntervalMs
      let released = false
      item.resolve(() => {
        if (released) return
        released = true
        active--
        drain()
      })
    }
  }
  const acquire = (signal: AbortSignal): Promise<() => void> => new Promise<() => void>((resolve, reject) => {
    if (signal.aborted) { reject(aborted(signal)); return }
    const item: PendingRequest = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = pending.indexOf(item)
        if (index !== -1) pending.splice(index, 1)
        reject(aborted(signal))
        drain()
      },
    }
    signal.addEventListener('abort', item.onAbort, { once: true })
    pending.push(item)
    drain()
  })

  function target(value: string | URL): URL {
    let url: URL
    try {
      url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error()
    } catch { throw error('INVALID_INPUT', '数据源请求地址无效') }
    if (!origins.has(url.origin)) throw error('ACCESS_DENIED', '数据源请求地址不在允许的来源范围内')
    return url
  }
  function retryAfter(value: string | null | undefined): number | undefined {
    if (!value?.trim()) return undefined
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined
  }
  function statusError(response: Response): CrawlerError {
    const status = response.status
    const code = status === 407 && proxyUrl ? 'PROXY_ERROR' : status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'ACCESS_DENIED'
      : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR'
    return error(code, `数据源返回 HTTP ${status}`, {
      upstreamStatus: status, retryable: TRANSIENT.has(status),
      retryAfterMs: retryAfter(response.headers.get('retry-after')),
    })
  }
  const discard = (response: Response): void => { response.body?.cancel().catch(() => {}) }

  function isProxyFailure(failure: unknown): boolean {
    if (!proxyUrl) return false
    const currentProxy = proxyUrl
    const proxyPort = Number(currentProxy.port || (currentProxy.protocol === 'https:' ? 443 : 80))
    for (let nested: TransportFailure | undefined = failure as TransportFailure, depth = 0; nested && depth < 5; nested = nested.cause, depth++) {
      if (['UND_ERR_PRX_TLS', 'UND_ERR_PRX_CONN'].includes(nested.code)) return true
      if (['ENOTFOUND', 'EAI_AGAIN'].includes(nested.code) && nested.hostname === currentProxy.hostname) return true
      if (nested.syscall === 'connect' && Number(nested.port) === proxyPort &&
          ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(nested.code)) return true
      // These messages are generated by this pinned ProxyAgent implementation.
      if (nested.code === 'UND_ERR_INVALID_ARG' && nested.message === 'Proxy Authentication Required (407)') return true
      if (nested.code === 'UND_ERR_ABORTED' && /^Proxy response \(\d+\) !== 200 when HTTP Tunneling$/.test(nested.message)) return true
    }
    return false
  }

  async function readText(response: Response, signal: AbortSignal): Promise<string> {
    const chunks = await readChunks(response, signal)
    return new TextDecoder().decode(Buffer.concat(chunks.buffers, chunks.size))
  }

  async function readBuffer(response: Response, signal: AbortSignal): Promise<Buffer> {
    const chunks = await readChunks(response, signal)
    return Buffer.concat(chunks.buffers, chunks.size)
  }

  async function readChunks(response: Response, signal: AbortSignal): Promise<ReadChunksResult> {
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > maxBodyBytes) {
      discard(response)
      throw error('RESPONSE_TOO_LARGE', '数据源响应超过大小限制')
    }
    if (!response.body) return { buffers: [], size: 0 }
    const reader = response.body.getReader()
    const buffers: Buffer[] = []
    let size = 0
    try {
      while (true) {
        assertActive(signal)
        const { value, done } = await abortable(reader.read(), signal)
        if (done) break
        size += value.byteLength
        if (size > maxBodyBytes) throw error('RESPONSE_TOO_LARGE', '数据源响应超过大小限制')
        buffers.push(Buffer.from(value))
      }
      return { buffers, size }
    } catch (failure) {
      reader.cancel().catch(() => {})
      throw failure
    } finally {
      try { reader.releaseLock() } catch { /* cancellation can still be releasing a pending read */ }
    }
  }

  async function attempt<T>(initialUrl: URL, options: CrawlerRequestOptions, signal: AbortSignal, read: ReadFunction<T>): Promise<T> {
    let url = initialUrl
    let method = (options.method || 'GET').toUpperCase()
    let body = options.body
    let headers: Headers
    try {
      headers = new Headers(options.headers)
      if (config.userAgent) headers.set('user-agent', config.userAgent)
      // Proxy credentials belong to the dispatcher and must never reach the origin.
      headers.delete('proxy-authorization')
    } catch { throw error('INVALID_INPUT', '数据源请求头无效') }
    for (let redirects = 0; ; redirects++) {
      assertActive(signal)
      const response = await abortable(fetchImpl(url.href, {
        method, headers, body, signal, dispatcher, redirect: 'manual',
      }), signal)
      if (!REDIRECTS.has(response.status)) {
        if (!response.ok) { discard(response); throw statusError(response) }
        return await read(response, signal)
      }
      discard(response)
      if (redirects >= maxRedirects) throw error('HTTP_ERROR', '数据源重定向次数超过限制')
      const location = response.headers.get('location')
      if (!location) throw error('HTTP_ERROR', '数据源重定向缺少目标地址')
      let next: URL
      try { next = target(new URL(location, url)) }
      catch (failure) {
        if (failure instanceof CrawlerError) throw failure
        throw error('INVALID_INPUT', '数据源重定向地址无效')
      }
      if (url.protocol === 'https:' && next.protocol !== 'https:') {
        throw error('ACCESS_DENIED', '不允许数据源重定向至未加密连接')
      }
      if (response.status === 303 && method !== 'HEAD' || [301, 302].includes(response.status) && method === 'POST') {
        method = 'GET'
        body = undefined
        headers.delete('content-type')
        headers.delete('content-length')
      }
      if (next.origin !== url.origin) {
        if (!['GET', 'HEAD'].includes(method)) {
          throw error('ACCESS_DENIED', '不允许携带请求内容跨来源重定向')
        }
        headers = new Headers([...headers].filter(([name]) => SAFE_REDIRECT_HEADERS.has(name)))
      }
      url = next
    }
  }

  async function request<T>(value: string | URL, options: CrawlerRequestOptions = {}, read: ReadFunction<T>): Promise<T> {
    if (closed) throw error('CLOSED', '数据源连接已关闭')
    const url = target(value)
    const signal = options.signal ? AbortSignal.any([options.signal, closing.signal]) : closing.signal
    const method = String(options.method || 'GET').toUpperCase()
    const mayRetry = options.retryable ?? ['GET', 'HEAD'].includes(method)
    for (let index = 0; ; index++) {
      assertActive(signal)
      const release = await acquire(signal)
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      let failure: CrawlerError
      try { return await attempt(url, options, requestSignal, read) }
      catch (caught) {
        failure = requestSignal.aborted ? aborted(requestSignal)
          : caught instanceof CrawlerError ? caught
            : isProxyFailure(caught) ? error('PROXY_ERROR', '无法通过配置的代理连接数据源', { retryable: true })
              : error('NETWORK_ERROR', '无法连接数据源', { retryable: true })
      } finally { release() }
      assertActive(signal)
      const wait = failure.retryAfterMs ?? Math.min(250 * 2 ** index, maxRetryDelayMs)
      if (!mayRetry || !failure.retryable || index >= maxRetries || wait > maxRetryDelayMs) throw failure
      // Never expose the request URL, source token, proxy URI or upstream exception.
      try { logger?.warn?.({ source, code: failure.code, retry: index + 1 }, '重试数据源请求') } catch {}
      await delay(wait, signal)
    }
  }

  const requestText = (value: string | URL, options?: CrawlerRequestOptions): Promise<string> => request(value, options, readText)
  const requestBuffer = (value: string | URL, options?: CrawlerRequestOptions): Promise<Buffer> => request(value, options, readBuffer)

  return {
    requestText,
    requestBuffer,
    async requestJson(url: string | URL, options?: CrawlerRequestOptions): Promise<any> {
      const text = await requestText(url, options)
      try { return JSON.parse(text) }
      catch { throw error('PARSE_ERROR', '数据源返回的 JSON 无效') }
    },
    close(): Promise<void> {
      if (closePromise) return closePromise
      closed = true
      closing.abort(error('CLOSED', '数据源连接已关闭'))
      clearTimeout(queueTimer)
      closePromise = Promise.resolve().then(() => dispatcher.close()).catch(() => {
        throw error('NETWORK_ERROR', '无法关闭数据源连接')
      })
      return closePromise
    },
  }
}
