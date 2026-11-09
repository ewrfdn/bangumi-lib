import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { CatalogResource } from '../service/catalog-validation.ts'

/** Route shapes used by every CRUD route; `params`/`query` default to `unknown` in Fastify v5. */
interface QueryRoute {
  Querystring: Record<string, unknown>
}
interface IdRoute {
  Params: { id: string }
}
interface IdBodyRoute extends IdRoute {
  Body: unknown
}
interface BodyRoute {
  Body: unknown
}

/** HTTP envelope and status codes shared by the three catalog CRUD resources. */
export function registerCrud<T>(app: FastifyInstance, url: string, service: CatalogResource<T>): void {
  app.get<QueryRoute>(url, async (request: FastifyRequest<QueryRoute>): Promise<unknown> => service.list(request.query))
  app.get<IdRoute>(`${url}/:id`, async (request: FastifyRequest<IdRoute>): Promise<unknown> => ({ item: service.get(request.params.id) }))
  app.post<BodyRoute>(url, async (request: FastifyRequest<BodyRoute>, reply: FastifyReply): Promise<FastifyReply> => {
    const item = service.create(request.body)
    return reply.code(201).send({ item })
  })
  app.patch<IdBodyRoute>(`${url}/:id`, async (request: FastifyRequest<IdBodyRoute>): Promise<unknown> => ({
    item: service.update(request.params.id, request.body),
  }))
  app.delete<IdRoute>(`${url}/:id`, async (request: FastifyRequest<IdRoute>): Promise<unknown> => service.remove(request.params.id))
}
