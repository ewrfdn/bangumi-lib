import { BaseAgent } from '../base.agent.ts'
import { createMediaScanTools } from '../tools/media-scan.tools.ts'
import type { AgentTool } from '../types.ts'
import type { CatalogModels } from '../../model/catalog.model.ts'
import type { Library, LibFolder, LocalMedia } from '../../types.ts'

export interface ScanEntry {
  name: string
  kind: 'dir' | 'file' | 'link'
  ext?: string
  size?: number
}

export interface ScanEntries {
  total: number
  truncated: boolean
  items: ScanEntry[]
}

export interface BangumiAgentContext {
  library: Pick<Library, 'id' | 'name' | 'root'>
  folder: Pick<LibFolder, 'relPath' | 'name' | 'depth'>
  entries: ScanEntries
  binding: LocalMedia | null
}

export interface BangumiAgentDependencies {
  services: Record<string, any>
  models: CatalogModels
  mediaSync: {
    findBinding(libraryId: string, relPath: string, options?: { mediaId?: number }): LocalMedia | null
    bindFolder(input: { libraryId: string; relPath: string; mediaId: number; signal?: AbortSignal }): Promise<Record<string, unknown>>
  }
}

/**
 * 番剧整理 Agent：判断一个目录是单个作品、合集还是无关内容，
 * 通过工具把结论写进媒体库。模型只做判断，落库全部由工具完成。
 */
export class BangumiAgent extends BaseAgent<BangumiAgentContext> {
  readonly type = 'bangumi'
  readonly label = '番剧整理'

  readonly #services: Record<string, any>
  readonly #models: CatalogModels
  readonly #mediaSync: BangumiAgentDependencies['mediaSync']

  constructor({ services, models, mediaSync }: BangumiAgentDependencies) {
    super()
    this.#services = services
    this.#models = models
    this.#mediaSync = mediaSync
  }

  systemPrompt(): string {
    return this.promptFile('media-scan.md')
  }

  userPrompt({ library, folder, entries, binding }: BangumiAgentContext): string {
    const media = binding ? this.#models.media.find({ id: binding.mediaId }) : null
    const payload = {
      library: { id: library.id, name: library.name },
      folder: { path: folder.relPath, name: folder.name, depth: folder.depth },
      entries: {
        total: entries.total,
        truncated: entries.truncated,
        items: entries.items.slice(0, 120).map((item) => ({
          name: item.name, kind: item.kind, ...(item.ext ? { ext: item.ext } : {}), ...(item.size !== undefined ? { size: item.size } : {}),
        })),
      },
      binding: binding ? {
        localMediaId: binding.id,
        media: media ? { id: media.id, title: media.title, season: media.season, dataSource: media.dataSource } : null,
      } : null,
    }
    return `请处理下面这个目录，判断它是什么并登记到媒体库。\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
  }

  tools({ library }: BangumiAgentContext): AgentTool[] {
    return createMediaScanTools({
      library, services: this.#services, models: this.#models, mediaSync: this.#mediaSync,
    })
  }
}
