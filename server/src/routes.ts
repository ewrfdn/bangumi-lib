import type { FastifyInstance } from 'fastify'
import { registerLibraryController } from './controller/library.controller.ts'
import { registerMediaController } from './controller/media.controller.ts'
import { registerPlaybackController } from './controller/playback.controller.ts'
import { registerProgressController } from './controller/progress.controller.ts'
import { registerAiController } from './controller/ai.controller.ts'
import { registerCatalogController } from './controller/catalog.controller.ts'
import { registerLocalMediaController } from './controller/local-media.controller.ts'
import { registerLocalMediaVideoController } from './controller/local-media-video.controller.ts'
import { registerMediaTracksController } from './controller/media-tracks.controller.ts'
import { registerTaskController } from './controller/task.controller.ts'
import { registerMetadataController } from './controller/metadata.controller.ts'
import { registerLibFolderController } from './controller/lib-folder.controller.ts'
import { registerScanController } from './controller/scan.controller.ts'
import { registerSchedulerController } from './controller/scheduler.controller.ts'
import type { Services } from './app.ts'
import type { AppConfig } from './types.ts'

/** Route registration only. Business logic belongs to injected services. */
export default async function registerRoutes(app: FastifyInstance, { services, settings }: { services: Services; settings: AppConfig }): Promise<void> {
  registerLibraryController(app, { libraryService: services.library })
  registerMediaController(app, { mediaService: services.media })
  registerPlaybackController(app, { playbackService: services.playback })
  registerProgressController(app, { progressService: services.progress })
  registerAiController(app, { aiSettingsService: services.aiSettings, agentService: services.agent, authService: services.auth })
  registerCatalogController(app, { catalogService: services.catalog })
  registerLocalMediaController(app, { localMediaService: services.localMedia })
  registerLocalMediaVideoController(app, { localMediaVideoService: services.localMediaVideo })
  registerMediaTracksController(app, { mediaTracksService: services.mediaTracks })
  registerTaskController(app, { taskService: services.task })
  registerMetadataController(app, { metadataService: services.metadata })
  registerLibFolderController(app, { libFolderService: services.libFolder, settings })
  registerScanController(app, { scanService: services.scan, taskRunner: services.taskRunner, settings })
  registerSchedulerController(app, { scheduler: services.scheduler })
}
