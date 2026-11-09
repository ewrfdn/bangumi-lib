/** Transport- and framework-independent, safe-to-serialize crawler failure. */

/** Optional failure metadata. Upstream messages and stacks are never retained. */
export interface CrawlerErrorOptions {
  /** HTTP status returned by the upstream source. */
  upstreamStatus?: number
  /** Alias accepted for callers that pass a generic status. */
  status?: number
  /** Server-requested retry delay in milliseconds. */
  retryAfterMs?: number
  /** Whether the same request may be safely repeated. */
  retryable?: boolean
  /** Any upstream failure; only its existence is recorded. */
  cause?: unknown
}

/** Credential-free, serializable projection produced by `toJSON`. */
export interface CrawlerErrorJSON {
  code: string
  source: string
  message: string
  upstreamStatus?: number
  retryAfterMs?: number
}

export class CrawlerError extends Error {
  readonly code: string
  readonly source: string
  readonly upstreamStatus?: number
  readonly retryAfterMs?: number
  readonly retryable?: boolean

  constructor(code: string, source: string, message: string, options: CrawlerErrorOptions = {}) {
    super(message)
    this.name = 'CrawlerError'
    this.code = code
    this.source = source
    const status = options.upstreamStatus ?? options.status
    if (Number.isInteger(status)) this.upstreamStatus = status
    const retryAfterMs = options.retryAfterMs
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs
    if (typeof options.retryable === 'boolean') this.retryable = options.retryable
    // Never retain upstream Error.message/stack: either may contain proxy credentials.
    if (options.cause) this.cause = { name: 'CrawlerFailure' }
  }

  toJSON(): CrawlerErrorJSON {
    const result: CrawlerErrorJSON = { code: this.code, source: this.source, message: this.message }
    if (this.upstreamStatus !== undefined) result.upstreamStatus = this.upstreamStatus
    if (this.retryAfterMs !== undefined) result.retryAfterMs = this.retryAfterMs
    return result
  }
}

export default CrawlerError
