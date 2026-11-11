import path from 'node:path'
import { HttpError } from '../../errors.ts'
import { array, boolean, fail, integer, mediaSummary, object, ok, resolveInside, text } from './tool-kit.ts'
import type { AgentTool } from '../types.ts'
import type { JsonSchema } from './tool-kit.ts'
import type { CatalogModels } from '../../model/catalog.model.ts'
import type { AppConfig, Library, LocalMediaVideo, Logger, Media, TaskRecord } from '../../types.ts'

/** 列表类工具单次返回上限，避免超大 tool result 挤占模型上下文。 */
const READ_LIMIT = 50
const FOLDER_LIMIT = 100
const VIDEO_LIMIT = 200
const TASK_STATUSES: readonly string[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
const TASK_STATUS_SCHEMA: JsonSchema = { type: 'string', enum: TASK_STATUSES, description: '可选，任务状态' }
const RESULT_MAX_CHARS = 4000
const SCAN_TIMEOUT_MS = 15 * 60 * 1000

export interface ChatToolDependencies {
  services: Record<string, any>
  models: CatalogModels
  settings: AppConfig
  logger?: Logger
}

/**
 * 媒体助手工具集：查询媒体库/目录/任务/进度，并在用户明确要求时执行抓取、编辑、扫描、归档。
 * 写工具标记 `sequential`，同一个目录的操作按顺序执行；整套工具没有删除能力。
 */
export function createChatTools({ services, models, settings, logger }: ChatToolDependencies): AgentTool[] {
  const libraryOf = (value: unknown): Library => {
    const requested = typeof value === 'string' && value.trim() ? value.trim() : ''
    const libraries = Array.isArray(settings.libraries) ? settings.libraries : []
    if (requested) {
      const found = libraries.find((item) => item.id === requested)
      if (!found) throw new HttpError(404, `媒体库不存在：${requested}`, 'LIBRARY_NOT_FOUND')
      return found
    }
    const fallback = libraries.find((item) => item.id === settings.defaultLibraryId) ?? libraries[0]
    if (!fallback) throw new HttpError(500, '没有可用的媒体库', 'LIBRARY_EMPTY')
    return fallback
  }

  const rootOf = (library: Library): string => {
    if (typeof library.root !== 'string' || !library.root) {
      throw new HttpError(500, `媒体库 ${library.id} 缺少根目录`, 'LIBRARY_ROOT_MISSING')
    }
    return path.resolve(library.root)
  }

  const positiveInt = (value: unknown, name: string): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(`${name}无效`)
    return value
  }

  const limitOf = (value: unknown, fallback: number, max = READ_LIMIT): number => {
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
      fail(`返回数量必须是 1 到 ${max} 的整数`)
    }
    return value
  }

  const offsetOf = (value: unknown): number => {
    if (value === undefined || value === null) return 0
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000_000) fail('offset 必须是自然数')
    return value
  }

  const keywordOf = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value.trim()) fail(`${name}不能为空`)
    return value.trim()
  }

  const mediaOf = (value: unknown): Media => {
    const mediaId = positiveInt(value, '影视 ID')
    const media = models.media.find({ id: mediaId })
    if (!media) throw new HttpError(404, `影视不存在：${mediaId}`)
    return media
  }

  /** 大段文本只保留预览，工具结果不携带整篇简介/错误堆栈。 */
  const clipText = (value: unknown, max: number): string | null => {
    if (typeof value !== 'string' || !value) return null
    return value.length > max ? `${value.slice(0, max)}…` : value
  }

  /** 可能很大的 JSON 结果压成预览；此处只做展示，不参与后续判断。 */
  const clip = (value: unknown, max = RESULT_MAX_CHARS): unknown => {
    if (value === undefined) return null
    let serialized: string | undefined
    try { serialized = JSON.stringify(value) } catch { return null }
    if (serialized === undefined) return null
    if (serialized.length <= max) return JSON.parse(serialized)
    return { truncated: true, preview: serialized.slice(0, max) }
  }

  const pick = (raw: Record<string, any>, keys: readonly string[]): Record<string, unknown> => {
    const fields: Record<string, unknown> = {}
    for (const key of keys) if (raw[key] !== undefined) fields[key] = raw[key]
    return fields
  }

  const videoSummary = (video: LocalMediaVideo) => ({
    videoId: video.id, title: video.title, index: video.videoIndex, path: video.mediaPath,
    missing: video.missing, sizeBytes: video.sizeBytes, durationMs: video.durationMs, coverPath: video.coverPath,
  })

  const mediaDetail = (media: Media) => ({
    mediaId: media.id, title: media.title, cover: media.cover, mediaType: media.mediaType,
    season: media.season, episodeCount: media.episodeCount, rating: media.rating, tags: media.tags,
    airedOn: media.airedOn, series: media.series, description: clipText(media.description, 2000),
    dataSource: media.dataSource, dataSourceUrl: media.dataSourceUrl,
    needsReview: Boolean((media.attribute?.scan as { needsReview?: boolean } | undefined)?.needsReview),
    createdAt: media.createdAt, updatedAt: media.updatedAt,
  })

  const taskSummary = (task: TaskRecord) => ({
    taskId: task.id, type: task.type, status: task.status, progress: task.progress,
    error: clipText(task.error, 200), createdAt: task.createdAt,
    startedAt: task.startedAt, finishedAt: task.finishedAt,
  })

  const taskDetail = (task: TaskRecord) => ({
    ...taskSummary(task),
    payload: clip(task.payload, 1000),
    result: clip(task.result, 2000),
    runAfter: task.runAfter, updatedAt: task.updatedAt,
  })

  /** 每个工具都带可选的 library 参数，统一在这里解析；默认使用默认媒体库。 */
  const libraryParam = (): JsonSchema => text('可选，媒体库 ID；不传时使用默认媒体库')
  const schema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
    object({ ...properties, library: libraryParam() }, required)

  return [
    // ------------------------------ 读：媒体库与影视 ------------------------------
    {
      name: 'list_libraries',
      label: '列出媒体库',
      description: '列出所有媒体库及其可用状态、作品数与视频数，用来了解当前环境。',
      parameters: schema({}),
      async execute(_id, params) {
        const library = libraryOf(params.library)
        const result = await services.library.libraries()
        return ok({
          defaultLibraryId: result.defaultLibraryId,
          currentLibraryId: library.id,
          libraries: (result.libraries ?? []).map((item: any) => ({
            id: item.id, name: item.name, mediaType: item.mediaType, root: item.root,
            available: item.available, seriesCount: item.seriesCount ?? null, videoCount: item.videoCount ?? null,
            ...(item.error ? { error: clipText(item.error, 500) } : {}),
          })),
        })
      },
    },
    {
      name: 'get_status',
      label: '服务状态',
      description: '查询服务运行状态：媒体库可用性、数据库信息、鉴权与 ffmpeg 转码能力。',
      parameters: schema({}),
      async execute(_id, params) {
        const library = libraryOf(params.library)
        const status = await services.library.status()
        return ok({
          ok: Boolean(status.ok), version: status.version, authEnabled: Boolean(status.authEnabled),
          root: status.root, rootExists: Boolean(status.rootExists),
          defaultLibraryId: status.defaultLibraryId, currentLibraryId: library.id,
          libraries: (status.libraries ?? []).map((item: any) => ({
            id: item.id, name: item.name, mediaType: item.mediaType, available: Boolean(item.available),
          })),
          database: clip(status.database, 1000),
          ffmpeg: {
            ffmpeg: status.ffmpeg ?? null, ffprobe: status.ffprobe ?? null,
            hwaccels: (status.hwaccels ?? []).slice(0, 10),
            encoders: (status.encoders ?? []).slice(0, 20),
            transcode: status.transcode ?? null, probeLatencyMs: status.probeLatencyMs ?? null,
          },
        })
      },
    },
    {
      name: 'browse_library',
      label: '浏览媒体库',
      description: '按名称浏览媒体库内的作品（磁盘目录），可看到是否已绑定影视与封面。',
      parameters: schema({
        keyword: text('可选，按作品名过滤的关键词'),
        limit: integer(`可选，返回数量，最多 ${READ_LIMIT}，默认 20`),
      }),
      async execute(_id, params) {
        const library = libraryOf(params.library)
        const limit = limitOf(params.limit, 20)
        const keyword = typeof params.keyword === 'string' ? params.keyword.trim().toLowerCase() : ''
        const catalog = await services.library.catalog(library.id)
        const matched = (catalog.series ?? []).filter((entry: any) => !keyword ||
          String(entry.name ?? '').toLowerCase().includes(keyword) ||
          String(entry.media?.title ?? '').toLowerCase().includes(keyword))
        return ok({
          library: {
            id: catalog.libraryId, name: catalog.libraryName, root: catalog.root,
            available: Boolean(catalog.available),
          },
          ...(catalog.error ? { error: clipText(catalog.error, 500) } : {}),
          total: matched.length,
          truncated: matched.length > limit,
          items: matched.slice(0, limit).map((entry: any) => ({
            path: entry.path, name: entry.name, kind: entry.kind, count: entry.count ?? null,
            poster: entry.poster ?? null, localCover: entry.localCover ?? null, mediaCount: entry.mediaCount ?? 0,
            media: entry.media ? {
              mediaId: entry.media.id, title: entry.media.title, season: entry.media.season,
              cover: entry.media.cover, dataSource: entry.media.dataSource,
            } : null,
          })),
        })
      },
    },
    {
      name: 'search_media',
      label: '搜索本地影视',
      description: '在本地数据库中按标题搜索影视记录，创建前用它查重。',
      parameters: schema({
        keyword: text('标题关键词'),
        limit: integer(`可选，返回数量，最多 ${READ_LIMIT}，默认 20`),
      }, ['keyword']),
      async execute(_id, params) {
        const library = libraryOf(params.library)
        const keyword = keywordOf(params.keyword, '关键词')
        const limit = limitOf(params.limit, 20)
        const result = services.catalog.list({ q: keyword, limit, offset: 0 })
        return ok({
          libraryId: library.id, total: result.total, limit: result.limit,
          truncated: result.items.length < result.total,
          items: result.items.map((media: Media) => mediaSummary(media)),
        })
      },
    },
    {
      name: 'list_media',
      label: '列出影视',
      description: '分页列出数据库中的影视记录（按 ID 倒序），可按媒体类型过滤。',
      parameters: schema({
        limit: integer(`可选，返回数量，最多 ${READ_LIMIT}，默认 20`),
        offset: integer('可选，跳过数量，默认 0'),
        mediaType: text('可选，媒体类型，如 anime / movie'),
      }),
      async execute(_id, params) {
        const library = libraryOf(params.library)
        const limit = limitOf(params.limit, 20)
        const offset = offsetOf(params.offset)
        const query: Record<string, unknown> = { limit, offset }
        if (params.mediaType !== undefined) {
          const mediaType = typeof params.mediaType === 'string' ? params.mediaType.trim() : ''
          if (!mediaType) fail('媒体类型不能为空')
          query.mediaType = mediaType
        }
        const result = services.catalog.list(query)
        return ok({
          libraryId: library.id, total: result.total, limit: result.limit, offset: result.offset,
          truncated: result.offset + result.items.length < result.total,
          items: result.items.map((media: Media) => mediaSummary(media)),
        })
      },
    },
    {
      name: 'get_media',
      label: '影视详情',
      description: '查看一条影视记录的完整资料、绑定的本地目录、视频（含缺失标记）与观看进度。',
      parameters: schema({ mediaId: integer('影视 ID') }, ['mediaId']),
      async execute(_id, params) {
        libraryOf(params.library)
        const media = mediaOf(params.mediaId)
        const bindings = models.localMedia.list({ limit: 50, offset: 0, filters: { mediaId: media.id } }).items
        const localMedia = bindings.map((binding) => {
          const videos = models.videos.list({ limit: VIDEO_LIMIT, offset: 0, filters: { localMediaId: binding.id } })
          return {
            localMediaId: binding.id, libraryId: binding.libraryId,
            folderName: binding.folderName, folderPath: binding.folderPath,
            totalVideos: videos.total, truncated: videos.items.length < videos.total,
            videos: videos.items.map(videoSummary),
          }
        })
        const tracks = models.tracks.list({ limit: READ_LIMIT, offset: 0, filters: { mediaId: media.id } })
        return ok({
          media: mediaDetail(media),
          localMedia,
          progress: {
            total: tracks.total, truncated: tracks.items.length < tracks.total,
            items: tracks.items.map((track) => ({
              videoIndex: track.videoIndex, positionMs: track.positionMs, durationMs: track.durationMs,
              completed: track.completed, watchedAt: track.watchedAt,
            })),
          },
        })
      },
    },
    // ------------------------------ 读：目录与外部资料 ------------------------------
    {
      name: 'list_folder',
      label: '列出库内目录',
      description: '列出媒体库内某个目录的直接子项（目录、视频、字幕等），根目录用空字符串。',
      parameters: schema({
        path: text('可选，相对媒体库根目录的路径；根目录用空字符串或 /'),
        limit: integer(`可选，返回数量，最多 ${FOLDER_LIMIT}，默认 50`),
      }),
      async execute(_id, params) {
        const library = libraryOf(params.library)
        const limit = limitOf(params.limit, 50, FOLDER_LIMIT)
        const requested = typeof params.path === 'string' ? params.path.trim() : ''
        const result = await services.library.list(requested, library.id)
        const all: any[] = result.items ?? []
        return ok({
          libraryId: result.libraryId ?? library.id,
          libraryName: result.libraryName ?? library.name,
          path: result.path,
          total: all.length,
          truncated: all.length > limit,
          items: all.slice(0, limit).map((item: any) => ({
            name: item.name, path: item.path, kind: item.kind,
            ext: item.ext || null, count: item.count ?? null, size: item.size ?? null, poster: item.poster ?? null,
          })),
        })
      },
    },
    {
      name: 'get_folder_binding',
      label: '查询目录绑定',
      description: '查询媒体库内某个目录绑定的影视记录与已收集的视频（含缺失标记）。',
      parameters: schema({ path: text('相对媒体库根目录的路径，根目录用空字符串') }, ['path']),
      async execute(_id, params) {
        const library = libraryOf(params.library)
        const { rel } = resolveInside(rootOf(library), params.path)
        const binding = services.mediaSync.findBinding(library.id, rel)
        if (!binding) return ok({ libraryId: library.id, path: rel, bound: false })
        const media = models.media.find({ id: binding.mediaId })
        const videos = models.videos.list({ limit: VIDEO_LIMIT, offset: 0, filters: { localMediaId: binding.id } })
        return ok({
          libraryId: library.id, path: rel, bound: true, localMediaId: binding.id,
          media: mediaSummary(media),
          total: videos.total, truncated: videos.items.length < videos.total,
          videos: videos.items.map(videoSummary),
        })
      },
    },
    {
      name: 'search_bangumi',
      label: '搜索 Bangumi',
      description: '按关键词搜索 Bangumi 动画条目，返回候选条目 ID、标题和年份；抓取前先用它找 ID。',
      parameters: schema({
        keyword: text('标题关键词'),
        year: integer('可选，四位年份'),
        limit: integer('可选，候选数量，最多 10，默认 5'),
      }, ['keyword']),
      async execute(_id, params, signal) {
        libraryOf(params.library)
        const keyword = keywordOf(params.keyword, '关键词')
        const limit = limitOf(params.limit, 5, 10)
        const body: Record<string, unknown> = { source: 'bangumi', keyword, limit }
        if (params.year !== undefined) {
          if (typeof params.year !== 'number' || !Number.isInteger(params.year) || params.year < 1000 || params.year > 9999) {
            fail('年份必须是四位数字')
          }
          body.year = params.year
        }
        const result = await services.metadata.search(body, { signal })
        return ok({
          total: result.total,
          items: (result.items ?? []).map((item: any) => ({
            source: item.source, sourceId: item.sourceId, title: item.title,
            originalTitle: item.originalTitle ?? null, mediaType: item.mediaType,
            platform: item.platform ?? null, airedOn: item.airedOn ?? null, cover: item.cover ?? null,
            sourceUrl: item.sourceUrl ?? null,
          })),
        })
      },
    },
    // ------------------------------ 读：进度、任务与调度 ------------------------------
    {
      name: 'list_watch_progress',
      label: '观看进度',
      description: '列出最近的播放进度（按时间倒序，最多 50 条）。',
      parameters: schema({
        limit: integer(`可选，返回数量，最多 ${READ_LIMIT}，默认 20`),
      }),
      async execute(_id, params) {
        const library = libraryOf(params.library)
        const limit = limitOf(params.limit, 20)
        const all: any[] = services.progress.list(library.id) ?? []
        return ok({
          libraryId: library.id, total: all.length, truncated: all.length > limit,
          items: all.slice(0, limit).map((item: any) => ({
            title: item.title, seriesTitle: item.seriesTitle ?? null, path: item.path,
            time: item.time, duration: item.duration,
            percent: item.duration > 0 ? Math.round((item.time / item.duration) * 100) : 0,
            at: item.at, poster: item.poster ?? null, seriesPath: item.seriesPath ?? null,
          })),
        })
      },
    },
    {
      name: 'list_tasks',
      label: '任务列表',
      description: '分页列出后台任务记录（扫描、定时任务等），可按状态或类型过滤。',
      parameters: schema({
        status: TASK_STATUS_SCHEMA,
        type: text('可选，任务类型，如 scan_library'),
        limit: integer(`可选，返回数量，最多 ${READ_LIMIT}，默认 20`),
        offset: integer('可选，跳过数量，默认 0'),
      }),
      async execute(_id, params) {
        libraryOf(params.library)
        const query: Record<string, unknown> = { limit: limitOf(params.limit, 20), offset: offsetOf(params.offset) }
        if (params.status !== undefined) {
          if (typeof params.status !== 'string' || !TASK_STATUSES.includes(params.status)) fail('任务状态无效')
          query.status = params.status
        }
        if (params.type !== undefined) query.type = keywordOf(params.type, '任务类型')
        const result = services.task.list(query)
        return ok({
          total: result.total, limit: result.limit, offset: result.offset,
          truncated: result.offset + result.items.length < result.total,
          items: result.items.map((task: TaskRecord) => taskSummary(task)),
        })
      },
    },
    {
      name: 'get_task',
      label: '任务详情',
      description: '查看单个后台任务的详情、参数与执行结果。',
      parameters: schema({ id: integer('任务 ID') }, ['id']),
      async execute(_id, params) {
        libraryOf(params.library)
        const taskId = positiveInt(params.id, '任务 ID')
        return ok(taskDetail(services.task.get(taskId)))
      },
    },
    {
      name: 'list_scheduler_tasks',
      label: '定时任务配置',
      description: '列出 tasks.yaml 中配置的定时任务、cron、启用状态与下次执行时间。',
      parameters: schema({}),
      async execute(_id, params) {
        libraryOf(params.library)
        const tasks: any[] = services.scheduler.list() ?? []
        return ok({
          timezone: services.scheduler.timezone,
          total: tasks.length,
          items: tasks.map((task: any) => ({
            type: task.type, cron: task.cron, enabled: Boolean(task.enabled), running: Boolean(task.running),
            timeoutMs: task.timeoutMs, nextRun: task.nextRun ?? null, options: clip(task.options, 500),
          })),
        })
      },
    },
    // ------------------------------ 写 / 归档 ------------------------------
    {
      name: 'crawl_bangumi',
      label: '抓取 Bangumi 条目',
      description: '按 Bangumi 条目 ID 抓取资料、下载封面并写入影视表；已存在时更新同一条记录。',
      parameters: schema({ subjectId: text('Bangumi 条目 ID，纯数字，来自 search_bangumi') }, ['subjectId']),
      executionMode: 'sequential',
      async execute(_id, params, signal) {
        libraryOf(params.library)
        const subjectId = String(params.subjectId ?? '').trim()
        if (!/^[1-9]\d{0,14}$/.test(subjectId)) fail('Bangumi 条目 ID 无效，只能使用 search_bangumi 返回的纯数字 ID')
        const result = await services.bangumiAsset.importSubject(subjectId, { signal })
        logger?.info?.({ subjectId, mediaId: result.media.id, created: result.created }, '媒体助手抓取 Bangumi 条目')
        return ok({
          mediaId: result.media.id, title: result.media.title,
          coverPath: result.coverPath ?? null, jsonPath: result.jsonPath, created: Boolean(result.created),
        })
      },
    },
    {
      name: 'create_media',
      label: '新建影视',
      description: '手动创建一条影视记录（编辑资料用），创建前先用 search_media 查重。',
      parameters: schema({
        title: text('标题'),
        mediaType: text('可选，媒体类型，默认 anime'),
        season: integer('可选，季号'),
        episodeCount: integer('可选，总集数'),
        description: text('可选，简介'),
        series: text('可选，系列名'),
        airedOn: text('可选，播出日期 YYYY-MM-DD'),
        tags: array(text('标签'), '可选，标签列表'),
        cover: text('可选，封面相对路径'),
      }, ['title']),
      executionMode: 'sequential',
      async execute(_id, params) {
        libraryOf(params.library)
        const title = keywordOf(params.title, '标题')
        const fields = { title, ...pick(params, ['mediaType', 'season', 'episodeCount', 'description', 'series', 'airedOn', 'tags', 'cover']) }
        const media = services.catalog.create(fields)
        logger?.info?.({ mediaId: media.id }, '媒体助手创建影视记录')
        return ok(mediaSummary(media))
      },
    },
    {
      name: 'update_media',
      label: '编辑影视',
      description: '修改已有影视记录的资料字段（标题、简介、封面、集数、季号、系列、日期等）。',
      parameters: schema({
        mediaId: integer('影视 ID'),
        title: text('可选，标题'),
        cover: text('可选，封面相对路径'),
        mediaType: text('可选，媒体类型'),
        season: integer('可选，季号'),
        episodeCount: integer('可选，总集数'),
        description: text('可选，简介'),
        rating: { type: 'number', description: '可选，评分 0-10' },
        tags: array(text('标签'), '可选，标签列表'),
        series: text('可选，系列名'),
        airedOn: text('可选，播出日期 YYYY-MM-DD'),
      }, ['mediaId']),
      executionMode: 'sequential',
      async execute(_id, params) {
        libraryOf(params.library)
        const media = mediaOf(params.mediaId)
        const fields = pick(params, ['title', 'cover', 'mediaType', 'season', 'episodeCount', 'description', 'rating', 'tags', 'series', 'airedOn'])
        if (!Object.keys(fields).length) fail('没有需要更新的字段')
        const updated = services.catalog.update(media.id, fields)
        logger?.info?.({ mediaId: media.id, fields: Object.keys(fields) }, '媒体助手编辑影视记录')
        return ok(mediaSummary(updated))
      },
    },
    {
      name: 'sync_local_media',
      label: '绑定目录并同步视频',
      description: '把媒体库内目录绑定到影视记录，并由服务端递归收集视频文件写入；已消失的视频标记缺失，不删除。',
      parameters: schema({
        path: text('相对媒体库根目录的路径'),
        mediaId: integer('影视 ID'),
      }, ['path', 'mediaId']),
      executionMode: 'sequential',
      async execute(_id, params, signal) {
        const library = libraryOf(params.library)
        const media = mediaOf(params.mediaId)
        const { rel } = resolveInside(rootOf(library), params.path)
        if (!rel) fail('不能把媒体库根目录绑定到影视记录')
        const result = await services.mediaSync.bindFolder({ libraryId: library.id, relPath: rel, mediaId: media.id, signal })
        logger?.info?.({ library: library.id, folder: rel, mediaId: media.id }, '媒体助手绑定目录并同步视频')
        return ok({ ...result, libraryId: library.id, path: rel, mediaId: media.id })
      },
    },
    {
      name: 'scan_library',
      label: '扫描媒体库',
      description: '触发一次异步媒体库扫描并立即返回任务 ID；扫描结果可在任务列表查看。未绑定的目录会交给整理 Agent；force=true 会忽略缓存重新分类所有目录（会再次调用模型，谨慎使用）。',
      parameters: schema({
        maxDepth: integer('可选，扫描深度 0-10，默认 4'),
        force: boolean('可选，强制重新分类所有目录（重试之前未识别/失败的目录时使用）'),
      }),
      executionMode: 'sequential',
      async execute(_id, params) {
        const library = libraryOf(params.library)
        const maxDepth = params.maxDepth === undefined ? 4 : params.maxDepth
        if (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) {
          fail('扫描深度必须是 0 到 10 的整数')
        }
        if (params.force !== undefined && typeof params.force !== 'boolean') fail('force 必须是布尔值')
        const force = params.force === true
        const started = services.taskRunner.start({
          key: `scan:${library.id}`,
          type: 'scan_library',
          payload: { libraryId: library.id, maxDepth, ...(force ? { force: true } : {}) },
          timeoutMs: SCAN_TIMEOUT_MS,
        }, ({ signal }: { signal: AbortSignal }) => services.scan.scanLibrary(library.id, { maxDepth, force, signal }))
        if (started.skipped) throw new HttpError(409, '该媒体库正在扫描，请稍后再试', 'SCAN_RUNNING')
        logger?.info?.({ library: library.id, taskId: started.taskId, maxDepth, force }, '媒体助手触发媒体库扫描')
        return ok({
          taskId: started.taskId, libraryId: library.id, maxDepth, force, async: true,
          message: '扫描已开始，完成后可在任务列表中查看结果。',
        })
      },
    },
    {
      name: 'run_scheduler_task',
      label: '立即执行定时任务',
      description: '立即触发一个已配置的定时任务（异步执行），返回任务 ID。',
      parameters: schema({ type: text('定时任务类型，如 tasks.yaml 中配置的 scan_library') }, ['type']),
      executionMode: 'sequential',
      async execute(_id, params) {
        libraryOf(params.library)
        const type = keywordOf(params.type, '任务类型')
        const configured = (services.scheduler.list() ?? []).some((task: any) => task.type === type)
        if (!configured) throw new HttpError(404, `未配置的定时任务：${type}`, 'SCHEDULER_TASK_NOT_FOUND')
        const result = await services.scheduler.runNow(type, { wait: false })
        if (result?.skipped) throw new HttpError(409, '定时任务正在运行，请稍后再试', 'TASK_RUNNING')
        logger?.info?.({ type, taskId: result?.taskId }, '媒体助手触发定时任务')
        return ok({
          type, taskId: result?.taskId ?? null, async: true,
          message: '定时任务已开始，完成后可在任务列表中查看结果。',
        })
      },
    },
    {
      name: 'cancel_task',
      label: '取消任务',
      description: '取消一个排队中或执行中的后台任务；已结束的任务不能取消。',
      parameters: schema({ id: integer('任务 ID') }, ['id']),
      executionMode: 'sequential',
      async execute(_id, params) {
        libraryOf(params.library)
        const taskId = positiveInt(params.id, '任务 ID')
        const task = services.task.cancel(taskId)
        logger?.info?.({ taskId: task.id }, '媒体助手取消任务')
        return ok({ taskId: task.id, type: task.type, status: task.status, cancelled: true })
      },
    },
  ]
}
