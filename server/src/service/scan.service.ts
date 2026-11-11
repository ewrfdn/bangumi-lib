import { HttpError } from '../errors.ts'
import { VIDEO_EXTS } from '../model/media.model.ts'
import type { AgentRunResult } from '../agent/types.ts'
import type { ScanAncestorBinding } from '../agent/agents/bangumi.agent.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { AppConfig, LibraryId, Logger, LocalMedia } from '../types.ts'
import type { LibFolderService, ScanFolderChange } from './lib-folder.service.ts'
import type { MediaAgentContext } from './media-agent.service.ts'

/** 本层是否有可直接入库的视频文件（字幕/图片/压缩包不算）。 */
const hasDirectVideo = (entries: ScanFolderChange['entries']): boolean =>
  entries.items.some((item) => item.kind === 'file' && typeof item.ext === 'string' && VIDEO_EXTS.has(`.${item.ext.toLowerCase()}`))

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
  /** 强制重新分类所有目录（用于重试上一次 Agent 没识别出来的目录）。 */
  force?: boolean
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
  /**
   * 查出当前目录所有已绑定的祖先目录（从浅到深）。
   * 祖先绑定会递归同步视频，子目录里的视频通常已经是该作品的番外/资源；
   * 把绑定信息交给 Agent，避免它把子目录误判成新作品或重复绑定。
   */
  const ancestorBindings = (libraryId: LibraryId, relPath: string): ScanAncestorBinding[] => {
    const segments = relPath.split('/').filter(Boolean)
    const result: ScanAncestorBinding[] = []
    for (let depth = 1; depth < segments.length; depth += 1) {
      const path = segments.slice(0, depth).join('/')
      const binding = mediaSync.findBinding(libraryId, path)
      if (!binding) continue
      const media = models.media.find({ id: binding.mediaId })
      result.push({
        path,
        localMediaId: binding.id,
        mediaId: binding.mediaId,
        title: media?.title ?? '',
        season: media?.season ?? 1,
        episodeCount: media?.episodeCount ?? 0,
        dataSource: media?.dataSource ?? null,
        dataSourceUrl: media?.dataSourceUrl ?? null,
      })
    }
    return result
  }

  async function scanLibrary(libraryId: LibraryId, { maxDepth = 4, force = false, signal }: ScanLibraryOptions = {}): Promise<LibraryScanSummary> {
    const library = settings.getLibrary(libraryId)
    const summary = { libraryId: library.id, classified: 0, synced: 0, deferred: 0, failed: 0 }
    const syncedBindings = new Set<number>()

    const result = await libFolderService.scan(library.id, {
      maxDepth, force, signal,
      onChanged: async ({ library: current, folder, entries }: ScanFolderChange): Promise<void> => {
        const binding = mediaSync.findBinding(current.id, folder.relPath)
        const media = binding ? models.media.find({ id: binding.mediaId }) : null

        // 信息已存在：不打扰模型，直接对齐视频文件。
        if (binding && media?.dataSource) {
          const synced = await mediaSync.syncVideos(binding, { signal })
          syncedBindings.add(binding.id)
          summary.synced += 1
          logger?.info?.({ library: current.id, folder: folder.relPath, ...synced }, '已绑定目录：仅同步视频')
          return
        }

        // 逐层扫描的归类边界：本层直接出现视频文件的目录才交给 Agent（绑定路径就是
        // 这个视频目录的完整相对路径）；纯容器目录不调用模型，直接标记 scanned，
        // 等子目录里真正出现视频时再绑定子目录。
        if (!hasDirectVideo(entries)) {
          logger?.info?.({ library: current.id, folder: folder.relPath }, '目录本层无视频文件：跳过归类')
          return
        }

        if (!mediaAgent?.enabled()) {
          summary.deferred += 1
          throw new HttpError(409, 'AI Agent 未启用，目录等待下次扫描', 'AI_DISABLED')
        }

        // 子目录可能位于已绑定作品内部（特典/番外/字幕组资源）；把祖先绑定信息一并交给
        // Agent，由它决定是复用祖先绑定还是报告需要拆分的独立作品。
        const ancestors = binding ? [] : ancestorBindings(current.id, folder.relPath)
        const outcome = await mediaAgent.classify({ library, folder, entries, binding, ancestors, signal })
        summary.classified += 1
        logger?.info?.({
          library: current.id, folder: folder.relPath, ancestors: ancestors.length,
          turns: outcome?.turns, toolCalls: outcome?.toolCalls,
        }, '目录已交给 Agent 处理')
      },
    })

    // 目录 mtime 未变化时不会触发 onChanged；已绑定目录仍要补扫，才能补齐新视频
    // 和缺失的视频中间帧封面。同步是幂等的，已处理的绑定不重复执行。
    const bindings = models.localMedia.list({ limit: 1000, offset: 0, filters: { libraryId: library.id } }).items
    for (const binding of bindings) {
      if (syncedBindings.has(binding.id)) continue
      if (signal?.aborted) throw new HttpError(499, '扫描已取消', 'CANCELLED')
      try {
        await mediaSync.syncVideos(binding, { signal })
        summary.synced += 1
      } catch (error) {
        if (signal?.aborted) throw error
        summary.failed += 1
        logger?.warn?.({ library: library.id, folder: binding.folderPath, error: (error as Error).message }, '已绑定目录补扫失败')
      }
    }

    return { ...summary, ...result, failed: summary.failed + result.failed }
  }

  return { scanLibrary }
}
