import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from '../../errors.ts'
import { probe } from '../../service/ffmpeg.service.ts'
import { array, fail, integer, mediaSummary, number, object, ok, resolveInside, text } from './tool-kit.ts'
import type { AgentTool } from '../types.ts'
import type { CatalogModels } from '../../model/catalog.model.ts'
import type { Library, LocalMedia, LocalMediaVideo, Logger } from '../../types.ts'

const IGNORED = new Set(['@eadir', '#recycle', '$recycle.bin', 'system volume information', 'node_modules'])
const ignored = (name: string): boolean => name.startsWith('.') || IGNORED.has(name.toLowerCase())
const LIST_LIMIT = 200

const RELEASE_NOISE = /\b(?:2160p?|1080p?|720p?|4k|uhd|hevc|h\.?26[45]|avc|x26[45]|10bit|8bit|aac|flac|web-?dl|webrip|blu-?ray|bdrip|bd|hdr|ma10p|v\d)\b/gi
const BRACKETED = /\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）|<[^>]*>/g
const TILDE = /[~～〜]/g

/**
 * 把本地目录名归一成 Bangumi 搜索关键词候选。
 * 常见失败原因：目录用半角 `~`、带字幕组/编码标记，或副标题太长；按优先级生成
 * 原名 → 全角波浪号 → 去掉发布标记 → 主标题，工具会依次尝试。
 */
export function searchKeywordVariants(keyword: string): string[] {
  const raw = keyword.replace(/\s+/g, ' ').trim()
  if (!raw) return []
  const candidates: string[] = []
  const add = (value: string): void => {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length >= 2 && !candidates.includes(normalized)) candidates.push(normalized)
  }
  add(raw)
  add(raw.replace(TILDE, '～').replace(/[［【]/g, '[').replace(/[］】]/g, ']'))
  const stripped = raw.replace(BRACKETED, ' ').replace(RELEASE_NOISE, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  add(stripped)
  const main = stripped.split(/\s*[~～〜]\s*|\s*[-–—:：]\s*/)[0]?.trim() ?? ''
  add(main)
  add(main.replace(TILDE, '～'))
  return candidates.slice(0, 4)
}

interface ListItem {
  name: string
  kind: 'dir' | 'file' | 'link'
  ext?: string
  size?: number
}

interface MediaScanToolDependencies {
  library: Pick<Library, 'id' | 'name' | 'root'>
  services: Record<string, any>
  models: CatalogModels
  mediaSync: {
    findBinding(libraryId: string, relPath: string, options?: { mediaId?: number }): LocalMedia | null
    bindFolder(input: { libraryId: string; relPath: string; mediaId: number; signal?: AbortSignal }): Promise<Record<string, unknown>>
  }
  logger?: Logger
}

/** 媒体扫描专用工具。写能力只有创建/编辑，没有删除。 */
export function createMediaScanTools({ library, services, models, mediaSync, logger }: MediaScanToolDependencies): AgentTool[] {
  if (typeof library.root !== 'string' || !library.root) {
    throw new HttpError(500, `媒体库 ${library.id} 缺少根目录，无法解析扫描路径`, 'LIBRARY_ROOT_MISSING')
  }
  const root = path.resolve(library.root)
  const resolve = (value: unknown): { rel: string; absolute: string } => resolveInside(root, value)
  const locateVideo = (value: unknown): { video: LocalMediaVideo; binding: LocalMedia; absolute: string } => {
    const id = Number(value)
    if (!Number.isSafeInteger(id) || id < 1) fail('视频 ID 无效')
    const video = models.videos.find({ id })
    if (!video) fail('视频记录不存在')
    const binding = models.localMedia.find({ id: video.localMediaId })
    if (!binding || binding.libraryId !== library.id) fail('视频不属于当前媒体库')
    const relative = binding.folderPath ? `${binding.folderPath}/${video.mediaPath}` : video.mediaPath
    return { video, binding, absolute: resolve(relative).absolute }
  }
  const videoBrief = (video: LocalMediaVideo) => ({
    id: video.id, path: video.mediaPath, index: video.videoIndex, type: video.videoType,
    coverPath: video.coverPath, durationMs: video.durationMs,
    width: video.width, height: video.height, frameCount: video.frameCount,
  })

  return [
    {
      name: 'list_folder',
      label: '列出目录',
      description: '列出媒体库内某个相对路径的一级子项（目录/文件、扩展名、大小）。',
      parameters: object({ path: text('相对媒体库根目录的路径，根目录用空字符串') }, ['path']),
      async execute(_id, params) {
        const { rel, absolute } = resolve(params.path)
        const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => null)
        if (!entries) throw new HttpError(404, `目录不存在：${rel || '/'}`)
        const items: ListItem[] = []
        for (const entry of entries) {
          if (ignored(entry.name) || items.length >= LIST_LIMIT) continue
          const item: ListItem = { name: entry.name, kind: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file' }
          if (item.kind === 'file') {
            item.ext = path.extname(entry.name).slice(1).toLowerCase()
            const stat = await fs.stat(path.join(absolute, entry.name)).catch(() => null)
            if (stat) item.size = stat.size
          }
          items.push(item)
        }
        return ok({ path: rel, items })
      },
    },
    {
      name: 'get_folder_binding',
      label: '查询目录绑定',
      description: '查询某个相对路径当前绑定到哪条影视记录、已有哪些视频记录。',
      parameters: object({ path: text('相对媒体库根目录的路径') }, ['path']),
      async execute(_id, params) {
        const { rel } = resolve(params.path)
        const binding = mediaSync.findBinding(library.id, rel)
        if (!binding) return ok({ bound: false, path: rel })
        const media = models.media.find({ id: binding.mediaId })
        const videos = models.videos.list({ limit: 500, offset: 0, filters: { localMediaId: binding.id } }).items
        return ok({
          bound: true, path: rel, localMediaId: binding.id, media: mediaSummary(media),
          videos: videos.map((video) => ({
            id: video.id, path: video.mediaPath, index: video.videoIndex, type: video.videoType,
            missing: video.missing, coverPath: video.coverPath, durationMs: video.durationMs,
            width: video.width, height: video.height, frameCount: video.frameCount,
          })),
        })
      },
    },
    {
      name: 'search_media',
      label: '搜索本地影视',
      description: '在本地数据库中按标题搜索影视记录，用来避免重复创建。',
      parameters: object({ keyword: text('标题关键词') }, ['keyword']),
      async execute(_id, params) {
        const keyword = String(params.keyword ?? '').trim()
        if (!keyword) fail('关键词不能为空')
        const result = services.catalog.list({ q: keyword, limit: 10, offset: 0 })
        return ok({ total: result.total, items: result.items.map(mediaSummary) })
      },
    },
    {
      name: 'search_bangumi',
      label: '搜索 Bangumi',
      description: '按关键词搜索 Bangumi 动画条目，返回候选条目 ID、标题、原始标题、播出日期和平台。续作/不同季度是独立条目，选条目时要结合文件夹路径里的季标识与 airedOn 年份判断，不要只按标题相似度选。原始关键词没有结果时会自动尝试简化标题、全角波浪号等变体，返回里的 triedKeywords 是实际用过的关键词。',
      parameters: object({ keyword: text('标题关键词'), year: integer('可选，四位年份') }, ['keyword']),
      async execute(_id, params, signal) {
        const keyword = String(params.keyword ?? '').trim()
        if (!keyword) fail('关键词不能为空')
        const variants = searchKeywordVariants(keyword).slice(0, 3)
        let result: any = null
        const triedKeywords: string[] = []
        for (const candidate of variants) {
          triedKeywords.push(candidate)
          result = await services.metadata.search({
            source: 'bangumi', keyword: candidate, limit: 5,
            ...(params.year !== undefined ? { year: params.year } : {}),
          }, { signal })
          // 有结果就停；空结果才尝试下一个变体，避免额外请求和限流。
          if (Array.isArray(result?.items) && result.items.length > 0) break
        }
        return ok({
          total: result?.total ?? 0,
          items: (result?.items ?? []).map((item: any) => ({
            sourceId: item.sourceId, title: item.title,
            originalTitle: item.originalTitle ?? null, airedOn: item.airedOn ?? null, platform: item.platform ?? null,
          })),
          triedKeywords,
        })
      },
    },
    {
      name: 'crawl_bangumi',
      label: '抓取 Bangumi 条目',
      description: '按 Bangumi 条目 ID 抓取资料，下载封面并写入影视表。已存在时更新同一条记录。',
      parameters: object({ subjectId: text('Bangumi 条目 ID，纯数字') }, ['subjectId']),
      executionMode: 'sequential',
      async execute(_id, params, signal) {
        const result = await services.bangumiAsset.importSubject(params.subjectId, { signal })
        return ok({
          mediaId: result.media.id, title: result.media.title, coverPath: result.coverPath,
          jsonPath: result.jsonPath, created: result.created,
        })
      },
    },
    {
      name: 'create_media_from_folder',
      label: '按目录名建影视',
      description: '没有匹配到 Bangumi 条目时，用文件夹名创建一条待确认的影视记录。',
      parameters: object({ path: text('相对媒体库根目录的路径'), title: text('可选，覆盖标题') }, ['path']),
      executionMode: 'sequential',
      async execute(_id, params) {
        const { rel } = resolve(params.path)
        if (!rel) fail('不能为媒体库根目录创建影视记录')
        const title = String(params.title ?? '').trim() || path.posix.basename(rel)
        const media = services.catalog.create({
          title, mediaType: 'anime',
          attribute: { scan: { origin: 'folder_name', needsReview: true, folderPath: rel } },
        })
        logger?.info?.({ mediaId: media.id, folder: rel }, '按文件夹名创建影视记录')
        return ok({ ...mediaSummary(media), needsReview: true })
      },
    },
    {
      name: 'update_media',
      label: '编辑影视',
      description: '编辑已有影视记录的字段。只允许资料字段，不涉及本地文件。',
      parameters: object({
        mediaId: integer('影视 ID'),
        title: text('标题'), description: text('简介'), cover: text('封面相对路径'),
        episodeCount: integer('总集数'), season: integer('季号'), series: text('系列名'),
        airedOn: text('播出日期 YYYY-MM-DD'),
      }, ['mediaId']),
      executionMode: 'sequential',
      async execute(_id, params) {
        const { mediaId, ...rest } = params
        const fields = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))
        if (!Object.keys(fields).length) fail('没有需要更新的字段')
        const media = services.catalog.update(mediaId, fields)
        return ok(mediaSummary(media))
      },
    },
    {
      name: 'sync_local_media',
      label: '同步目录与视频',
      description: '把目录绑定到影视记录，并由服务端递归收集视频文件写入。已消失的视频标记缺失，不删除。',
      parameters: object({
        path: text('相对媒体库根目录的路径'),
        mediaId: integer('影视 ID'),
        videos: array(text('视频相对路径'), '可选；仅作核对，实际以服务端扫描为准'),
      }, ['path', 'mediaId']),
      executionMode: 'sequential',
      async execute(_id, params, signal) {
        const { rel } = resolve(params.path)
        const result = await mediaSync.bindFolder({ libraryId: library.id, relPath: rel, mediaId: params.mediaId, signal })
        return ok({ path: rel, ...result })
      },
    },
    {
      name: 'inspect_video',
      label: '读取视频源信息',
      description: '读取某个视频记录的时长、分辨率和总帧数，并写入 local_media_video 归档字段。用于人工/Agent 核对片源。',
      parameters: object({ videoId: integer('视频记录 ID，可从 get_folder_binding 获取') }, ['videoId']),
      executionMode: 'sequential',
      async execute(_id, params) {
        const { video, absolute } = locateVideo(params.videoId)
        const stat = await fs.stat(absolute).catch(() => null)
        if (!stat?.isFile()) fail('视频文件不存在')
        const info = await probe(absolute, { timeoutMs: 15_000 })
        if (!info?.video) fail('无法读取视频流信息（ffprobe 不可用或文件损坏）')
        const patch: Record<string, number> = {}
        const durationMs = info.duration > 0 ? Math.round(info.duration * 1000) : null
        if (durationMs !== null) patch.durationMs = durationMs
        if (info.video.width > 0) patch.width = info.video.width
        if (info.video.height > 0) patch.height = info.video.height
        if (info.video.frames && info.video.frames > 0) patch.frameCount = info.video.frames
        if (Object.keys(patch).length) models.videos.update({ id: video.id }, patch)
        const updated = models.videos.find({ id: video.id })
        return ok({
          ...(updated ? videoBrief(updated) : videoBrief(video)),
          fps: info.video.fps, codec: info.video.codec, size: stat.size,
        })
      },
    },
    {
      name: 'screenshot_video',
      label: '截取视频封面',
      description: '截取视频中间帧生成 480p 封面并写入该视频记录，用于特典/番外没有封面或需要人工核对画面的情况。',
      parameters: object({ videoId: integer('视频记录 ID，可从 get_folder_binding 获取') }, ['videoId']),
      executionMode: 'sequential',
      async execute(_id, params) {
        const { video, absolute } = locateVideo(params.videoId)
        const stat = await fs.stat(absolute).catch(() => null)
        if (!stat?.isFile()) fail('视频文件不存在')
        const cover = services.videoCover
        if (!cover?.ensure) fail('封面生成服务不可用')
        const coverPath = await cover.ensure(absolute, video.localMediaId, video.mediaPath, { force: true })
        if (!coverPath) fail('截取视频帧失败（ffmpeg 不可用或文件损坏）')
        models.videos.update({ id: video.id }, { coverPath })
        return ok({ id: video.id, path: video.mediaPath, coverPath, url: `/assets/${coverPath}` })
      },
    },
    {
      name: 'update_videos',
      label: '更新视频类型/集号',
      description: '批量修正视频记录：把正片标为 main、特典/番外标为 extra，并可修正集号。用于 Bangumi 总集数规则不适用或自动分类有误的目录。',
      parameters: object({
        videos: array(object({
          id: integer('视频记录 ID'),
          videoType: { type: 'string', enum: ['main', 'extra'], description: 'main=正片，extra=番外/特典' },
          videoIndex: number('集号；正片通常 1..总集数，番外可用 12.5 这类小数'),
        }, ['id']), '要修正的视频列表'),
      }, ['videos']),
      executionMode: 'sequential',
      async execute(_id, params) {
        const list = Array.isArray(params.videos) ? params.videos : fail('videos 必须是数组')
        if (!list.length || list.length > 100) fail('一次需要更新 1-100 条视频')
        const updated: ReturnType<typeof videoBrief>[] = []
        for (const item of list) {
          const { video } = locateVideo(item?.id)
          const patch: Record<string, unknown> = {}
          if (item.videoType !== undefined) {
            if (!['main', 'extra'].includes(item.videoType)) fail('videoType 必须是 main 或 extra')
            patch.videoType = item.videoType
          }
          if (item.videoIndex !== undefined) {
            const value = Number(item.videoIndex)
            if (!Number.isFinite(value) || value < 0 || value > 1_000_000) fail('videoIndex 无效')
            patch.videoIndex = value
          }
          if (!Object.keys(patch).length) fail('没有需要更新的字段')
          const row = models.videos.update({ id: video.id }, patch)
          if (row) updated.push(videoBrief(row))
        }
        return ok({ count: updated.length, videos: updated })
      },
    },
    {
      name: 'report',
      label: '提交结论',
      description: '结束本轮处理并提交结论。每个目录必须调用一次。',
      parameters: object({
        kind: { type: 'string', enum: ['media', 'container', 'ignored', 'failed'], description: '目录判定结果' },
        summary: text('一句话说明做了什么或为什么跳过'),
        mediaId: integer('可选，最终关联的影视 ID'),
      }, ['kind', 'summary']),
      async execute(_id, params) {
        return { ...ok({ kind: params.kind, summary: params.summary, mediaId: params.mediaId ?? null }), terminate: true }
      },
    },
  ]
}
