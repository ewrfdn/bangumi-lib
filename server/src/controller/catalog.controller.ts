import type { FastifyInstance } from 'fastify'
import type { Media } from '../types.ts'
import type { CatalogService } from '../service/catalog.service.ts'
import { registerCrud } from './catalog-http.ts'

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface CatalogControllerDependencies {
  readonly catalogService: CatalogService
}

export function registerCatalogController(app: FastifyInstance, { catalogService }: CatalogControllerDependencies): void {
  registerCrud<Media>(app, '/api/media', catalogService)
}
