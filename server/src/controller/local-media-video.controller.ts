import type { FastifyInstance } from 'fastify'
import type { LocalMediaVideo } from '../types.ts'
import type { CatalogResource } from '../service/catalog-validation.ts'
import { registerCrud } from './catalog-http.ts'

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface LocalMediaVideoControllerDependencies {
  readonly localMediaVideoService: CatalogResource<LocalMediaVideo>
}

export function registerLocalMediaVideoController(
  app: FastifyInstance,
  { localMediaVideoService }: LocalMediaVideoControllerDependencies,
): void {
  registerCrud<LocalMediaVideo>(app, '/api/local-media-videos', localMediaVideoService)
}
