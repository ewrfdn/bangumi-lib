import Fastify, { LogController } from 'fastify'
import type { FastifyError, FastifyRequest, FastifyReply, FastifyServerOptions } from 'fastify'
import cors from '@fastify/cors'
import { config } from './config.ts'
import { createDatabase, type AniShareDatabase } from './model/database.ts'
import { createAuthService } from './service/auth.service.ts'
import { createProgressService } from './service/progress.service.ts'
import { createLibraryService } from './service/library.service.ts'
import { createMediaService } from './service/media.service.ts'
import { createSubtitleService } from './service/subtitle.service.ts'
import { createPlaybackService } from './service/playback.service.ts'
import { createAiSettingsService } from './service/ai-settings.service.ts'
import { createSearchSettingsService } from './service/search-settings.service.ts'
import { createDeepSeekSearchService } from './service/deepseek-search.service.ts'
import { createAgentService } from './service/agent.service.ts'
import { createCatalogService } from './service/catalog.service.ts'
import { createLocalMediaService } from './service/local-media.service.ts'
import { createLocalMediaVideoService } from './service/local-media-video.service.ts'
import { createMediaTracksService } from './service/media-tracks.service.ts'
import { createTaskService } from './service/task.service.ts'
import { createMetadataService } from './service/metadata.service.ts'
import { createBangumiAssetService } from './service/bangumi-asset.service.ts'
import { createLibFolderService } from './service/lib-folder.service.ts'
import { createMediaSyncService } from './service/media-sync.service.ts'
import { createVideoCoverService } from './service/video-cover.service.ts'
import { createMediaAgentService } from './service/media-agent.service.ts'
import { createScanService } from './service/scan.service.ts'
import { createTaskRunner } from './service/task-runner.service.ts'
import { createChatService } from './service/chat.service.ts'
import { createSchedulerManager } from './scheduler/manager.ts'
import { createTaskRegistry, type TaskRegistry } from './scheduler/registry.ts'
import { createCrawlerRegistry } from './crawler/registry.ts'
import { registerAuthController } from './controller/auth.controller.ts'
import { registerAssetsController } from './controller/assets.controller.ts'
import { registerAgentChatController } from './controller/agent-chat.controller.ts'
import { AgentManager } from './agent/AgentManager.ts'
import { BangumiAgent } from './agent/agents/bangumi.agent.ts'
import { ChatAgent } from './agent/agents/chat.agent.ts'
import { runPiAgent, runPiAgentWithTools } from './agent/pi.runtime.ts'
import type { AppConfig } from './types.ts'
import registerRoutes from './routes.ts'

export interface Services {
  auth: ReturnType<typeof createAuthService>
  progress: ReturnType<typeof createProgressService>
  library: ReturnType<typeof createLibraryService>
  subtitles: ReturnType<typeof createSubtitleService>
  media: ReturnType<typeof createMediaService>
  playback: ReturnType<typeof createPlaybackService>
  aiSettings: ReturnType<typeof createAiSettingsService>
  searchSettings: ReturnType<typeof createSearchSettingsService>
  search: ReturnType<typeof createDeepSeekSearchService>
  agent: ReturnType<typeof createAgentService>
  catalog: ReturnType<typeof createCatalogService>
  localMedia: ReturnType<typeof createLocalMediaService>
  localMediaVideo: ReturnType<typeof createLocalMediaVideoService>
  mediaTracks: ReturnType<typeof createMediaTracksService>
  task: ReturnType<typeof createTaskService>
  metadata: ReturnType<typeof createMetadataService>
  bangumiAsset: ReturnType<typeof createBangumiAssetService>
  libFolder: ReturnType<typeof createLibFolderService>
  mediaSync: ReturnType<typeof createMediaSyncService>
  videoCover: ReturnType<typeof createVideoCoverService>
  mediaAgent: ReturnType<typeof createMediaAgentService>
  scan: ReturnType<typeof createScanService>
  taskRunner: ReturnType<typeof createTaskRunner>
  scheduler: ReturnType<typeof createSchedulerManager>
  agentManager: AgentManager
}

export interface CreateAppOptions extends Partial<AppConfig> {
  logger?: FastifyServerOptions['logger']
  crawlerRegistry?: ReturnType<typeof createCrawlerRegistry>
  crawlerDependencies?: Record<string, unknown>
  runPiAgent?: typeof runPiAgent
  runPiAgentWithTools?: typeof runPiAgentWithTools
  /** 便于测试注入 DeepSeek 搜索请求实现。 */
  searchFetch?: typeof fetch
  taskRegistry?: TaskRegistry
  tasksTimezone?: string
}

/** Composition root: construct dependencies and expose an API-only application. */
export async function createApp(options: CreateAppOptions = {}) {
  const settings: AppConfig = { ...config, ...options }
  const app = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL || 'info' },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
  })
  const crawlerRegistry = options.crawlerRegistry || createCrawlerRegistry(settings.crawlers, {
    logger: app.log, ...options.crawlerDependencies,
  })
  let database: AniShareDatabase
  try { database = createDatabase(settings.dbPath, settings.defaultLibraryId) }
  catch (error) { await crawlerRegistry.close(); throw error }
  app.addHook('preClose', async () => crawlerRegistry.close())
  app.addHook('onClose', async () => database.close())
  const services = {} as Services
  services.auth = createAuthService(database, settings)
  services.progress = createProgressService(database, settings)
  services.library = createLibraryService({ database, settings })
  services.subtitles = createSubtitleService({ dataDir: settings.dataDir })
  services.media = createMediaService(settings, services.subtitles)
  services.playback = createPlaybackService(settings)
  services.aiSettings = createAiSettingsService(database, settings)
  services.searchSettings = createSearchSettingsService({ database, settings, aiSettings: services.aiSettings })
  services.search = createDeepSeekSearchService({ settings: services.searchSettings, logger: app.log, fetchImpl: options.searchFetch })
  services.catalog = createCatalogService(database.catalog)
  services.localMedia = createLocalMediaService(database.catalog, settings)
  services.localMediaVideo = createLocalMediaVideoService(database.catalog)
  services.mediaTracks = createMediaTracksService(database.catalog)
  services.task = createTaskService(database.catalog)
  // 进程重启后，旧进程里的任务不会再被接管：把残留的 running/queued 标记为失败，
  // 避免任务页永远显示“运行中”；需要时重新触发即可。
  for (const status of ['running', 'queued'] as const) {
    const stale = database.catalog.task.list({ limit: 1000, offset: 0, filters: { status } }).items
    for (const row of stale) {
      database.catalog.task.transition(row, {
        status: 'failed', error: '服务重启，任务中断；请重新触发', finishedAt: Date.now(),
      })
    }
  }
  services.metadata = createMetadataService({ registry: crawlerRegistry, catalogService: services.catalog })
  services.bangumiAsset = createBangumiAssetService({
    registry: crawlerRegistry, catalogService: services.catalog, models: database.catalog, settings, logger: app.log,
  })
  services.libFolder = createLibFolderService({ models: database, settings })
  const videoCover = createVideoCoverService({ settings })
  services.videoCover = videoCover
  services.mediaSync = createMediaSyncService({
    models: database.catalog, settings, localMediaService: services.localMedia, videoCover,
  })
  services.agentManager = new AgentManager({
    resolveConfig: () => services.aiSettings.effective(),
    runner: options.runPiAgentWithTools || runPiAgentWithTools,
    logger: app.log,
  })
  services.agentManager.register(new BangumiAgent({
    services, models: database.catalog, mediaSync: services.mediaSync,
    search: services.search, searchSettings: services.searchSettings,
  }))
  services.agentManager.register(new ChatAgent({
    services, models: database.catalog, settings, logger: app.log,
    search: services.search, searchSettings: services.searchSettings,
  }))
  const chatService = createChatService({ agents: services.agentManager, aiSettings: services.aiSettings })
  services.mediaAgent = createMediaAgentService({ aiSettings: services.aiSettings, agents: services.agentManager })
  services.scan = createScanService({
    libFolderService: services.libFolder, mediaSync: services.mediaSync, models: database.catalog,
    settings, mediaAgent: services.mediaAgent, logger: app.log,
  })
  services.taskRunner = createTaskRunner({ models: database.catalog, logger: app.log })
  services.scheduler = createSchedulerManager({
    configPath: settings.tasksConfigPath,
    timezone: options.tasksTimezone || 'Asia/Shanghai',
    registry: options.taskRegistry || createTaskRegistry(),
    context: { services, settings },
    models: database.catalog,
    logger: app.log,
    runner: services.taskRunner,
  })
  app.decorate('scheduler', services.scheduler)
  app.addHook('onReady', async () => { await services.scheduler.start() })
  app.addHook('onClose', async () => { await services.scheduler.stop() })
  services.agent = createAgentService(services.aiSettings, options.runPiAgent || runPiAgent)
  app.decorate('database', database)
  app.decorate('services', Object.freeze(services))
  app.decorate('aiSettings', services.aiSettings)
  app.decorate('authEnabled', services.auth.enabled)
  app.addHook('onClose', async () => services.playback.stopAll())
  app.addHook('onClose', async () => services.subtitles.close())
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = error.statusCode || (error as { status?: number }).status || 500
    if (status >= 500) app.log.error(error)
    reply.code(status).send({ error: error.message || '服务器内部错误', ...(error.code ? { code: error.code } : {}) })
  })
  app.server.keepAliveTimeout = 120_000
  app.server.headersTimeout = 121_000
  app.server.requestTimeout = 0
  if (settings.frontendOrigins?.length) {
    await app.register(cors, { origin: settings.frontendOrigins, credentials: true })
  }
  registerAuthController(app, { authService: services.auth, settings })
  registerAssetsController(app, { settings })
  await app.register(registerRoutes, { services, settings })
  registerAgentChatController(app, { chatService, authService: services.auth, settings, logger: app.log })
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: '接口不存在' }))
  return app
}
