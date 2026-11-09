import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { LibraryService } from '../service/library.service.ts'
import { HttpError } from '../errors.ts'
import { stringValue } from './http.ts'

interface QueryRoute {
  Querystring: Record<string, unknown>
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface LibraryControllerDependencies {
  readonly libraryService: LibraryService
}

export function registerLibraryController(app: FastifyInstance, { libraryService }: LibraryControllerDependencies): void {
  app.get('/api/status', () => libraryService.status())
  app.get('/api/libraries', () => libraryService.libraries())
  app.get<QueryRoute>('/api/library', (request: FastifyRequest<QueryRoute>) => libraryService.catalog(stringValue(request.query.library)))
  app.get<QueryRoute>('/api/library/series', (request: FastifyRequest<QueryRoute>) => {
    for (const key of Object.keys(request.query)) {
      if (!['path', 'library'].includes(key)) throw new HttpError(400, `不支持查询参数：${key}`)
    }
    return libraryService.series(stringValue(request.query.path), stringValue(request.query.library))
  })
  app.get<QueryRoute>('/api/list', (request: FastifyRequest<QueryRoute>) =>
    libraryService.list(stringValue(request.query.path), stringValue(request.query.library)))
}
