import { BaseAgent } from '../base.agent.ts'
import { createMediaScanTools } from '../tools/media-scan.tools.ts'
import { createSearchTools } from '../tools/search.tools.ts'
import type { AgentTool } from '../types.ts'
import type { CatalogModels } from '../../model/catalog.model.ts'
import type { Library, LibFolder, LocalMedia } from '../../types.ts'
import type { DeepSeekSearchService } from '../../service/deepseek-search.service.ts'
import type { SearchSettingsService } from '../../service/search-settings.service.ts'

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

/** 当前目录的某个祖先目录已经绑定的作品；帮助 Agent 判断子目录是番外/资源还是独立作品。 */
export interface ScanAncestorBinding {
  /** 祖先目录相对路径（从浅到深） */
  path: string
  localMediaId: number
  mediaId: number
  title: string
  season: number
  episodeCount: number
  dataSource: string | null
  dataSourceUrl: string | null
}

export interface BangumiAgentContext {
  library: Pick<Library, 'id' | 'name' | 'root'>
  folder: Pick<LibFolder, 'relPath' | 'name' | 'depth'>
  entries: ScanEntries
  binding: LocalMedia | null
  /** 祖先目录的绑定信息（可能多级）；祖先绑定会递归同步视频，子目录不应重复绑定。 */
  ancestors?: ScanAncestorBinding[]
}

export interface BangumiAgentDependencies {
  services: Record<string, any>
  models: CatalogModels
  mediaSync: {
    findBinding(libraryId: string, relPath: string, options?: { mediaId?: number }): LocalMedia | null
    bindFolder(input: { libraryId: string; relPath: string; mediaId: number; signal?: AbortSignal }): Promise<Record<string, unknown>>
  }
  /** 可选联网搜索：Bangumi 搜不到时用于确认作品标题/别名。 */
  search?: DeepSeekSearchService
  searchSettings?: SearchSettingsService
}

/**
 * 番剧整理 Agent：判断一个目录是单个作品、合集还是无关内容，
 * 通过工具把结论写进媒体库。模型只做判断，落库全部由工具完成。
 */
export class BangumiAgent extends BaseAgent<BangumiAgentContext> {
  readonly type = 'bangumi'
  readonly label = '番剧整理'
  // 搜索 → 抓取 → 绑定 → 抽查分类通常需要 8 轮以上；上限太低会在收尾前被截断，
  // 导致目录只建了一半记录或退化成「待确认」占位。复杂目录（多季/多字幕组）可能更久。
  readonly maxTurns = 20
  readonly maxToolCalls = 50
  readonly timeoutMs = 300_000

  readonly #services: Record<string, any>
  readonly #models: CatalogModels
  readonly #mediaSync: BangumiAgentDependencies['mediaSync']
  readonly #search?: DeepSeekSearchService
  readonly #searchSettings?: SearchSettingsService

  constructor({ services, models, mediaSync, search, searchSettings }: BangumiAgentDependencies) {
    super()
    this.#services = services
    this.#models = models
    this.#mediaSync = mediaSync
    this.#search = search
    this.#searchSettings = searchSettings
  }

  systemPrompt(): string {
    return this.promptFile('media-scan.md')
  }

  userPrompt({ library, folder, entries, binding, ancestors = [] }: BangumiAgentContext): string {
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
        media: media ? {
          id: media.id, title: media.title, season: media.season, episodeCount: media.episodeCount,
          dataSource: media.dataSource,
        } : null,
      } : null,
      ancestors: ancestors.slice(0, 5).map((ancestor) => ({
        path: ancestor.path, localMediaId: ancestor.localMediaId, mediaId: ancestor.mediaId,
        title: ancestor.title, season: ancestor.season, episodeCount: ancestor.episodeCount,
        dataSource: ancestor.dataSource, dataSourceUrl: ancestor.dataSourceUrl,
      })),
    }
    return `请处理下面这个目录，判断它是什么并登记到媒体库。\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
  }

  tools({ library }: BangumiAgentContext): AgentTool[] {
    const tools = createMediaScanTools({
      library, services: this.#services, models: this.#models, mediaSync: this.#mediaSync,
    })
    // Bangumi 搜不到时的「按需搜索补强」：只有后台开启联网搜索且配置了可用密钥才注册，
    // 未配置 API Key 时不注册，避免模型调用必然失败的工具。
    if (this.#search && this.#searchSettings?.usable()) {
      tools.push(...createSearchTools({ search: this.#search }))
    }
    return tools
  }
}
