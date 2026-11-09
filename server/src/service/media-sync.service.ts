import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from '../errors.ts'
import { VIDEO_EXTS } from '../model/media.model.ts'
import { folderHash } from './local-media.service.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { AppConfig, Library, LibraryId, LocalMedia, LocalMediaVideo } from '../types.ts'

const SYSTEM_DIRECTORIES = new Set(['@eadir', '#recycle', '$recycle.bin', 'system volume information', 'node_modules'])
const ignored = (name: string): boolean => name.startsWith('.') || SYSTEM_DIRECTORIES.has(name.toLowerCase())
const cancelled = (): HttpError => new HttpError(499, '操作已取消', 'CANCELLED')

/** 从文件名推断集号；推断不出时由调用方按顺序编号。 */
export function videoIndexOf(name: string): number | null {
  const base = path.parse(name).name
  let match = /[Ss](\d{1,2})[Ee](\d{1,4})/.exec(base)
  if (match) return Number(match[2])
  match = /(?:第|\[)(\d{1,4})(?:集|话|話|\])/.exec(base)
  if (match) return Number(match[1])
  match = /(?:^|[^\d])(\d{1,3})(?:v\d)?(?:[^\d]|$)/.exec(base)
  if (match) return Number(match[1])
  return null
}

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
}

/**
 * 媒体库目录与视频记录的落库：目录 → local_media，视频文件 → local_media_video。
 * Agent 与扫描任务共用这一份，保证两条路径的判定完全一致。
 */
export function createMediaSyncService({ models, settings, localMediaService }: MediaSyncServiceDependencies): MediaSyncService {
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
    const existing = models.videos.list({ limit: 5000, offset: 0, filters: { localMediaId: binding.id } }).items
    const byPath = new Map<string, LocalMediaVideo>(existing.map((video): [string, LocalMediaVideo] => [video.mediaPath, video]))
    let created = 0, updated = 0, missing = 0, order = 0

    for (const file of found) {
      order += 1
      const previous = byPath.get(file.mediaPath)
      if (!previous) {
        models.videos.create({
          localMediaId: binding.id, mediaId: binding.mediaId, mediaPath: file.mediaPath, title: file.title,
          videoIndex: videoIndexOf(file.title) ?? order, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs,
        })
        created += 1
        continue
      }
      const patch: Record<string, unknown> = {}
      if (previous.sizeBytes !== file.sizeBytes) patch.sizeBytes = file.sizeBytes
      if (previous.mtimeMs !== file.mtimeMs) patch.mtimeMs = file.mtimeMs
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
