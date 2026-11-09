import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig, LibraryId } from '../types.ts'
import type { createLibFolderService } from '../service/lib-folder.service.ts'
import { HttpError } from '../errors.ts'

interface QueryRoute {
  Querystring: Record<string, unknown>
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface LibFolderControllerDependencies {
  readonly libFolderService: ReturnType<typeof createLibFolderService>
  readonly settings: AppConfig
}

/** 已扫描目录树。默认隐藏 missing 目录及其子树。 */
export function registerLibFolderController(app: FastifyInstance, { libFolderService, settings }: LibFolderControllerDependencies): void {
  app.get<QueryRoute>('/api/lib-folders', async (request: FastifyRequest<QueryRoute>): Promise<unknown> => {
    const query = request.query ?? {}
    for (const key of Object.keys(query)) {
      if (!['library', 'includeMissing'].includes(key)) throw new HttpError(400, `不支持查询参数：${key}`)
    }
    // Query values are dynamic; `getLibrary` rejects unusable values exactly as it did before.
    const library = settings.getLibrary((query.library ?? settings.defaultLibraryId) as LibraryId)
    const includeMissing = query.includeMissing === '1' || query.includeMissing === 'true'
    const items = libFolderService.list(library.id, { includeMissing })
    return {
      libraryId: library.id,
      libraryName: library.name,
      root: library.root,
      includeMissing,
      stats: libFolderService.stats(library.id),
      items,
    }
  })
}
