import { HttpError } from '../errors.ts'
import type { AgentRunResult } from '../agent/types.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { AppConfig, LibraryId, Logger, LocalMedia } from '../types.ts'
import type { LibFolderService, ScanFolderChange } from './lib-folder.service.ts'
import type { MediaAgentContext } from './media-agent.service.ts'

/** 扫描服务依赖的 Agent 能力；与 media-agent.service 的 classify 参数一一对应。 */
export interface ScanAgent {
  enabled(): boolean
  classify(context: MediaAgentContext): Promise<AgentRunResult>
}

/** 扫描服务用到媒体同步的两个入口。 */
export interface ScanMediaSync {
  findBinding(libraryId: LibraryId, relPath: string): LocalMedia | null
  syncVideos(binding: LocalMedia, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>
}

export interface ScanLibraryOptions {
  maxDepth?: number
  signal?: AbortSignal
}

export interface LibraryScanSummary {
  libraryId: string
  classified: number
  synced: number
  deferred: number
  visited: number
  changed: number
  failed: number
  missing: number
  durationMs: number
}

export interface ScanService {
  scanLibrary(libraryId: LibraryId, options?: ScanLibraryOptions): Promise<LibraryScanSummary>
}

export interface ScanServiceDependencies {
  libFolderService: LibFolderService
  mediaSync: ScanMediaSync
  models: CatalogModels
  settings: AppConfig
  mediaAgent?: ScanAgent
  logger?: Logger
}

/**
 * 扫描编排：目录变更 → 已绑定且有资料来源的直接同步视频，其余交给 Agent。
 * Agent 未启用时只做确定性同步，并把待分类目录留到下一次扫描。
 */
export function createScanService({ libFolderService, mediaSync, models, settings, mediaAgent, logger }: ScanServiceDependencies): ScanService {
  async function scanLibrary(libraryId: LibraryId, { maxDepth = 4, signal }: ScanLibraryOptions = {}): Promise<LibraryScanSummary> {
    const library = settings.getLibrary(libraryId)
    const summary = { libraryId: library.id, classified: 0, synced: 0, deferred: 0 }

    const result = await libFolderService.scan(library.id, {
      maxDepth, signal,
      onChanged: async ({ library: current, folder, entries }: ScanFolderChange): Promise<void> => {
        const binding = mediaSync.findBinding(current.id, folder.relPath)
        const media = binding ? models.media.find({ id: binding.mediaId }) : null

        // 信息已存在：不打扰模型，直接对齐视频文件。
        if (binding && media?.dataSource) {
          const synced = await mediaSync.syncVideos(binding, { signal })
          summary.synced += 1
          logger?.info?.({ library: current.id, folder: folder.relPath, ...synced }, '已绑定目录：仅同步视频')
          return
        }

        if (!mediaAgent?.enabled()) {
          summary.deferred += 1
          throw new HttpError(409, 'AI Agent 未启用，目录等待下次扫描', 'AI_DISABLED')
        }

        const outcome = await mediaAgent.classify({ library, folder, entries, binding, signal })
        summary.classified += 1
        logger?.info?.({
          library: current.id, folder: folder.relPath, turns: outcome?.turns, toolCalls: outcome?.toolCalls,
        }, '目录已交给 Agent 处理')
      },
    })

    return { ...summary, ...result }
  }

  return { scanLibrary }
}
