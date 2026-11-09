import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { CrawlerContext, MetadataService } from '../service/metadata.service.ts'
import { CrawlerError } from '../crawler/crawler-error.ts'

const statuses: Record<string, number> = {
  INVALID_INPUT: 400, UNSUPPORTED_FILTER: 400, UNSUPPORTED_SOURCE: 400,
  SOURCE_DISABLED: 503, NOT_FOUND: 404, AUTH_REQUIRED: 502, ACCESS_DENIED: 502,
  RATE_LIMITED: 429, TIMEOUT: 504, CANCELLED: 499,
  PROXY_ERROR: 502, NETWORK_ERROR: 502, PARSE_ERROR: 502, INVALID_RESULT: 502,
}

/**
 * `CrawlerError` assigns these in its constructor but declares no fields (the crawler layer is
 * out of migration scope), so they are read structurally after the `instanceof` check.
 */
interface CrawlerFailure {
  readonly code: string
  readonly source?: string
  readonly retryAfterMs?: number
}

const failureOf = (error: CrawlerError): CrawlerFailure => error as unknown as CrawlerFailure

/** Cancellation context handed to metadata operations. */
type MetadataContext = CrawlerContext

interface IdRoute {
  Params: { id: string }
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface MetadataControllerDependencies {
  readonly metadataService: MetadataService
}

export function registerMetadataController(app: FastifyInstance, { metadataService }: MetadataControllerDependencies): void {
  const execute = async <T>(request: FastifyRequest, reply: FastifyReply, operation: (context: MetadataContext) => T | Promise<T>): Promise<unknown> => {
    reply.header('Cache-Control', 'no-store')
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    const responseClosed = (): void => { if (!reply.raw.writableEnded) abort() }
    request.raw.once('aborted', abort)
    reply.raw.once('close', responseClosed)
    if (request.raw.aborted || reply.raw.destroyed) abort()
    try {
      return await operation({ signal: controller.signal })
    } catch (error) {
      if (!(error instanceof CrawlerError)) throw error
      const failure = failureOf(error)
      const retryAfterMs = failure.retryAfterMs
      if (failure.code === 'RATE_LIMITED' && typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)) {
        reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
      }
      return reply.code(statuses[failure.code] || 502).send({
        error: error.message, code: failure.code, ...(failure.source ? { source: failure.source } : {}),
      })
    } finally {
      request.raw.off('aborted', abort)
      reply.raw.off('close', responseClosed)
    }
  }
  app.get('/api/metadata/sources', (request: FastifyRequest, reply: FastifyReply) =>
    execute(request, reply, () => ({ items: metadataService.sources() })))
  app.post('/api/metadata/search', (request: FastifyRequest, reply: FastifyReply) =>
    execute(request, reply, (context: MetadataContext) => metadataService.search(request.body, context)))
  app.post('/api/metadata/preview', (request: FastifyRequest, reply: FastifyReply) =>
    execute(request, reply, async (context: MetadataContext) => ({ item: await metadataService.preview(request.body, context) })))
  app.post<IdRoute>('/api/media/:id/metadata', (request: FastifyRequest<IdRoute>, reply: FastifyReply) =>
    execute(request, reply, async (context: MetadataContext) => ({ item: await metadataService.apply(request.params.id, request.body, context) })))
}
