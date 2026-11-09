import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ProgressService } from '../service/progress.service.ts'

interface QueryRoute {
  Querystring: Record<string, unknown>
}
interface ImportRoute {
  Body: { items?: unknown } | null
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface ProgressControllerDependencies {
  readonly progressService: ProgressService
}

/**
 * Query values arrive as `unknown`; the service re-validates them, so only the static type is
 * asserted here to keep the original pass-through behaviour (arrays still reach the service).
 */
const optionalString = (value: unknown): string | undefined => value as string | undefined

export function registerProgressController(app: FastifyInstance, { progressService }: ProgressControllerDependencies): void {
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    if (new URL(req.url, 'http://localhost').pathname.startsWith('/api/progress')) reply.header('Cache-Control', 'no-store')
    return payload
  })
  app.get<QueryRoute>('/api/progress', async (req: FastifyRequest<QueryRoute>): Promise<unknown> =>
    ({ items: progressService.list(optionalString(req.query.library)) }))
  app.put<{ Body: unknown }>('/api/progress', async (req: FastifyRequest<{ Body: unknown }>): Promise<unknown> =>
    ({ item: progressService.save(req.body) }))
  app.post<ImportRoute>('/api/progress/import', async (req: FastifyRequest<ImportRoute>): Promise<unknown> =>
    ({ items: progressService.import(req.body?.items) }))
  app.delete<QueryRoute>('/api/progress', async (req: FastifyRequest<QueryRoute>): Promise<unknown> =>
    progressService.remove(req.query.path, optionalString(req.query.library)))
}
