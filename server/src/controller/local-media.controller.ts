import type { FastifyInstance } from 'fastify'
import type { LocalMedia } from '../types.ts'
import type { CatalogResource } from '../service/catalog-validation.ts'
import { registerCrud } from './catalog-http.ts'

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface LocalMediaControllerDependencies {
  readonly localMediaService: CatalogResource<LocalMedia>
}

export function registerLocalMediaController(app: FastifyInstance, { localMediaService }: LocalMediaControllerDependencies): void {
  registerCrud<LocalMedia>(app, '/api/local-media', localMediaService)
}
