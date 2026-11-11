import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from '../errors.ts'
import { VIDEO_EXTS } from '../model/media.model.ts'
import { folderHash } from './local-media.service.ts'
import { probe } from './ffmpeg.service.ts'
import { classifyVideos, parseEpisodeNumber } from './video-classification.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { VideoCoverGenerator } from './video-cover.service.ts'
import type { AppConfig, Library, LibraryId, LocalMedia, LocalMediaVideo } from '../types.ts'

const SYSTEM_DIRECTORIES = new Set(['@eadir', '#recycle', '$recycle.bin', 'system volume information', 'node_modules'])
const ignored = (name: string): boolean => name.startsWith('.') || SYSTEM_DIRECTORIES.has(name.toLowerCase())
const cancelled = (): HttpError => new HttpError(499, '操作已取消', 'CANCELLED')

/** 从文件名推断集号；推断不出时由调用方按顺序编号。 */
export const videoIndexOf = (name: string): number | null => parseEpisodeNumber(name)

/** 递归收集到的视频文件；mediaPath 相对媒体库目录。 */
export interface VideoFile {
  mediaPath: string
  title: string
  sizeBytes: number
  mtimeMs: number
}

export type VideoSyncResult = {
  localMediaId: number
  mediaId: number
  total: number
  created: number
  updated: number
  missing: number
}

export interface BindFolderInput {
  libraryId: LibraryId
  relPath: string
  mediaId: number
  signal?: AbortSignal
}

/** local-media.service 里用到的两个写方法。 */
export interface LocalMediaWriter {
  create(data: Record<string, unknown>): LocalMedia
  update(value: unknown, data: Record<string, unknown>): LocalMedia | null
}

export interface MediaSyncService {
  findBinding(libraryId: LibraryId, relPath: string): LocalMedia | null
  bindFolder(input?: BindFolderInput): Promise<VideoSyncResult>
  syncVideos(binding: LocalMedia, options?: { signal?: AbortSignal }): Promise<VideoSyncResult>
  collectVideos(directory: string, options?: { maxDepth?: number; signal?: AbortSignal }): Promise<VideoFile[]>
  resolveFolder(library: Library, relPath?: string): string
}

export interface MediaSyncServiceDependencies {
  models: CatalogModels
  settings: AppConfig
  localMediaService: LocalMediaWriter
  /** 可选：扫描时抽取视频中间帧生成封面。 */
  videoCover?: VideoCoverGenerator
}

/**
 * 媒体库目录与视频记录的落库：目录 → local_media，视频文件 → local_media_video。
 * Agent 与扫描任务共用这一份，保证两条路径的判定完全一致。
 */
export function createMediaSyncService({ models, settings, localMediaService, videoCover }: MediaSyncServiceDependencies): MediaSyncService {
  const resolveFolder = (library: Library, relPath?: string): string => {
    const root = path.resolve(library.root)
    const absolute = path.resolve(root, relPath || '.')
    if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new HttpError(403, '路径越界')
    return absolute
  }

  async function collectVideos(directory: string, { maxDepth = 4, signal }: { maxDepth?: number; signal?: AbortSignal } = {}): Promise<VideoFile[]> {
    const found: VideoFile[] = []
    const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
      if (signal?.aborted) throw cancelled()
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (signal?.aborted) throw cancelled()
        if (ignored(entry.name) || entry.isSymbolicLink()) continue
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (depth < maxDepth) await walk(path.join(current, entry.name), relative, depth + 1)
          continue
        }
        if (!VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) continue
        const stat = await fs.stat(path.join(current, entry.name)).catch(() => null)
        if (!stat) continue
        found.push({ mediaPath: relative, title: entry.name, sizeBytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) })
      }
    }
    await walk(directory, '', 0)
    return found.sort((left, right) => left.mediaPath.localeCompare(right.mediaPath, 'zh-CN', { numeric: true }))
  }

  const findBinding = (libraryId: LibraryId, relPath: string): LocalMedia | null => {
    const hash = folderHash(libraryId, relPath)
    return models.localMedia.findWhere('library_id = ? AND folder_hash = ?', [libraryId, hash])
  }

  /** 已绑定目录：只同步文件，不调用 Agent。 */
  async function syncVideos(binding: LocalMedia, { signal }: { signal?: AbortSignal } = {}): Promise<VideoSyncResult> {
    const library = settings.getLibrary(binding.libraryId)
    const directory = resolveFolder(library, binding.folderPath)
    const stat = await fs.stat(directory).catch(() => null)
    if (!stat?.isDirectory()) throw new HttpError(404, `目录不可用：${binding.folderPath}`)

    const found = await collectVideos(directory, { signal })
    const media = models.media.find({ id: binding.mediaId })
    const classification = classifyVideos(found, { episodeCount: media?.episodeCount })
    const existing = models.videos.list({ limit: 5000, offset: 0, filters: { localMediaId: binding.id } }).items
    const byPath = new Map<string, LocalMediaVideo>(existing.map((video): [string, LocalMediaVideo] => [video.mediaPath, video]))
    let created = 0, updated = 0, missing = 0, order = 0
    const metadataFor = async (file: VideoFile, previous: LocalMediaVideo | undefined): Promise<Record<string, number | null>> => {
      const unchanged = previous && previous.mtimeMs === file.mtimeMs && previous.sizeBytes === file.sizeBytes
      const complete = previous && previous.durationMs && previous.width != null && previous.height != null && previous.frameCount != null
      if (unchanged && complete) return {}
      const info = await probe(path.join(directory, file.mediaPath), { timeoutMs: 15_000 }).catch(() => null)
      if (!info) return {}
      const width = info.video?.width || null
      const height = info.video?.height || null
      const frameCount = info.video?.frames || null
      const durationMs = info.duration > 0 ? Math.round(info.duration * 1000) : null
      const metadata: Record<string, number | null> = {}
      if (durationMs !== null && durationMs !== previous?.durationMs) metadata.durationMs = durationMs
      if (width !== previous?.width) metadata.width = width
      if (height !== previous?.height) metadata.height = height
      if (frameCount !== previous?.frameCount) metadata.frameCount = frameCount
      return metadata
    }
    const coverFor = async (file: VideoFile, previous: LocalMediaVideo | undefined): Promise<string | null> => {
      if (!videoCover) return previous?.coverPath ?? null
      const changed = !previous || previous.mtimeMs !== file.mtimeMs || previous.sizeBytes !== file.sizeBytes
      if (previous?.coverPath && !changed) return previous.coverPath
      if (signal?.aborted) return previous?.coverPath ?? null
      try {
        const cover = await videoCover.ensure(path.join(directory, file.mediaPath), binding.id, file.mediaPath, {
          force: Boolean(previous?.coverPath) && changed,
        })
        return cover ?? previous?.coverPath ?? null
      } catch {
        return previous?.coverPath ?? null
      }
    }

    for (const file of found) {
      order += 1
      const previous = byPath.get(file.mediaPath)
      const type = classification.get(file.mediaPath) ?? { videoType: 'main' as const, videoIndex: videoIndexOf(file.title) ?? order }
      const metadata = await metadataFor(file, previous)
      const coverPath = await coverFor(file, previous)
      if (!previous) {
        models.videos.create({
          localMediaId: binding.id, mediaId: binding.mediaId, mediaPath: file.mediaPath, title: file.title,
          videoType: type.videoType, videoIndex: type.videoIndex,
          sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, ...metadata,
          ...(coverPath ? { coverPath } : {}),
        })
        created += 1
        continue
      }
      const patch: Record<string, unknown> = { ...metadata }
      if (previous.videoType !== type.videoType) patch.videoType = type.videoType
      if (previous.videoIndex !== type.videoIndex) patch.videoIndex = type.videoIndex
      if (previous.sizeBytes !== file.sizeBytes) patch.sizeBytes = file.sizeBytes
      if (previous.mtimeMs !== file.mtimeMs) patch.mtimeMs = file.mtimeMs
      if (coverPath && coverPath !== previous.coverPath) patch.coverPath = coverPath
      if (previous.missing) patch.missing = false
      if (Object.keys(patch).length) { models.videos.update({ id: previous.id }, patch); updated += 1 }
      byPath.delete(file.mediaPath)
    }
    for (const gone of byPath.values()) {
      if (gone.missing) continue
      models.videos.update({ id: gone.id }, { missing: true })
      missing += 1
    }
    return { localMediaId: binding.id, mediaId: binding.mediaId, total: found.length, created, updated, missing }
  }

  /** 新建或复用 local_media，并同步其视频。 */
  async function bindFolder({ libraryId, relPath, mediaId, signal }: BindFolderInput = {} as BindFolderInput): Promise<VideoSyncResult> {
    const library = settings.getLibrary(libraryId)
    const directory = resolveFolder(library, relPath)
    const stat = await fs.stat(directory).catch(() => null)
    if (!stat?.isDirectory()) throw new HttpError(404, `目录不存在：${relPath}`)

    let binding = findBinding(libraryId, relPath)
    if (!binding) {
      binding = localMediaService.create({ libraryId, folderPath: relPath, mediaId })
    } else if (binding.mediaId !== Number(mediaId)) {
      // 换绑：local_media 与视频的复合外键必须一起迁移，事务内延迟检查。
      const current = binding
      binding = models.transaction((): LocalMedia => {
        const videos = models.videos.list({ limit: 5000, offset: 0, filters: { localMediaId: current.id } }).items
        // 记录刚存在；update 只会返回同一条记录，null 说明事务外被并发删除。
        const updated = localMediaService.update(current.id, { mediaId })
        if (!updated) throw new HttpError(404, '本地目录记录不存在')
        for (const video of videos) models.videos.update({ id: video.id }, { mediaId: updated.mediaId })
        return updated
      })
    }
    return syncVideos(binding, { signal })
  }

  return { findBinding, bindFolder, syncVideos, collectVideos, resolveFolder }
}
