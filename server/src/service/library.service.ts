import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.ts'
import { HttpError } from '../errors.ts'
import { VIDEO_EXTS, directoryAvailable, directoryAvailableSync, listDirectory, resolveVirtual, scanLibrary, toVirtual } from '../model/media.model.ts'
import { capabilities } from './ffmpeg.service.ts'
import type { AniShareDatabase, DatabaseInfo } from '../model/database.ts'
import type { MediaEntry, ScanEntry } from '../model/media.model.ts'
import type { FfmpegCapabilities } from './ffmpeg.service.ts'
import type { AppConfig, Library, LocalMedia, Media } from '../types.ts'

/** Cached scan statistics for one library root; `error` replaces the counts when a scan failed. */
interface LibraryStatistics {
  root: string
  at: number
  seriesCount?: number
  videoCount?: number
  error?: string
}

export interface LibraryAvailability extends Library {
  available: boolean
}

export interface LibraryEntry extends LibraryAvailability {
  seriesCount: number | null
  videoCount: number | null
  error?: string
}

export interface LibraryStatus extends FfmpegCapabilities {
  ok: boolean
  root: string
  rootExists: boolean
  defaultLibraryId: string
  libraries: LibraryAvailability[]
  database: DatabaseInfo
  authEnabled: boolean
  version: string
}

export interface LibraryCatalog {
  root: string
  libraryId: string
  libraryName: string
  available: boolean
  series: LibrarySeries[]
  error?: string
}

/** A disk series plus the first media record bound to it (for covers and titles). */
export type LibrarySeries = ScanEntry & { media: Media | null; mediaCount: number }

export interface SeriesVideo {
  name: string
  path: string
  seasonPath: string
  seasonName: string
  mediaId: number | null
  size: number
  mtime: number
}

export interface LibrarySeriesDetail {
  libraryId: string
  libraryName: string
  path: string
  name: string
  kind: 'dir' | 'video'
  count: number
  poster: string | null
  media: Media[]
  videos: SeriesVideo[]
}

export interface LibraryDirectory {
  path: string
  root: string
  libraryId: string
  libraryName: string
  items: MediaEntry[]
}

export interface LibraryService {
  status(): Promise<LibraryStatus>
  libraries(): Promise<{ defaultLibraryId: string; libraries: LibraryEntry[] }>
  catalog(libraryId?: string): Promise<LibraryCatalog>
  series(pathValue?: string, libraryId?: string): Promise<LibrarySeriesDetail>
  list(directory?: string, libraryId?: string): Promise<LibraryDirectory>
}

export interface LibraryServiceOptions {
  database: AniShareDatabase
  settings?: AppConfig
}

/** Catalog and availability policy, independent of HTTP and response objects. */
export function createLibraryService({ database, settings = config }: LibraryServiceOptions): LibraryService {
  const statistics = new Map<string, LibraryStatistics>()
  const statisticsTtl = 60_000
  const resolveLibrary = (id?: string): Library => settings.getLibrary(id || settings.defaultLibraryId)
  const decodePath = (value: string): string => { try { return decodeURIComponent(value) } catch { return value } }
  /** DB folder paths are stored decoded, while virtual paths are URL-encoded. */
  const relOf = (virtualPath: string): string => decodePath(virtualPath).replace(/^\/+|\/+$/g, '')
  const bindingsFor = (libraryId: string): LocalMedia[] =>
    database.catalog.localMedia.list({ limit: 1000, offset: 0, filters: { libraryId } }).items
  const mediaOf = (bindings: LocalMedia[]): Map<number, Media> => {
    const result = new Map<number, Media>()
    for (const binding of bindings) {
      if (result.has(binding.mediaId)) continue
      const media = database.catalog.media.find({ id: binding.mediaId })
      if (media) result.set(binding.mediaId, media)
    }
    return result
  }

  return {
    async status(): Promise<LibraryStatus> {
      return {
        ok: true,
        root: settings.mediaRoot,
        rootExists: directoryAvailableSync(settings.mediaRoot),
        defaultLibraryId: settings.defaultLibraryId,
        libraries: settings.libraries.map((library) => ({
          ...library, available: directoryAvailableSync(library.root),
        })),
        ...await capabilities(),
        database: database.info(),
        authEnabled: Boolean(settings.authSecret),
        version: '0.1.0',
      }
    },
    async libraries(): Promise<{ defaultLibraryId: string; libraries: LibraryEntry[] }> {
      return {
        defaultLibraryId: settings.defaultLibraryId,
        libraries: await Promise.all(settings.libraries.map(async (library): Promise<LibraryEntry> => {
          const available = await directoryAvailable(library.root)
          const previous = statistics.get(library.id)
          const cached = previous && previous.root === library.root && Date.now() - previous.at < statisticsTtl ? previous : null
          if (!available) statistics.delete(library.id)
          const error = available ? cached?.error : null
          return {
            ...library,
            available: available && !error,
            seriesCount: available && !error ? cached?.seriesCount ?? null : null,
            videoCount: available && !error ? cached?.videoCount ?? null : null,
            ...(error ? { error } : {}),
          }
        })),
      }
    },
    async catalog(libraryId?: string): Promise<LibraryCatalog> {
      const library = resolveLibrary(libraryId)
      const context = {
        root: library.root, libraryId: library.id, libraryName: library.name,
        available: await directoryAvailable(library.root),
      }
      try {
        if (!context.available) throw new Error('目录不存在或不可用')
        const series = await scanLibrary(library.id)
        const bindings = bindingsFor(library.id)
        const mediaById = mediaOf(bindings)
        const enriched: LibrarySeries[] = series.map((entry) => {
          const relPath = relOf(entry.path)
          const matches = bindings.filter((binding) => binding.folderPath === relPath || binding.folderPath.startsWith(relPath + '/'))
          const binding = matches
            .slice()
            .sort((a, b) => a.folderPath.length - b.folderPath.length || a.folderPath.localeCompare(b.folderPath, 'zh-CN'))[0]
          return {
            ...entry,
            media: binding ? mediaById.get(binding.mediaId) ?? null : null,
            mediaCount: new Set(matches.map((item) => item.mediaId)).size,
          }
        })
        statistics.set(library.id, {
          root: library.root, at: Date.now(), seriesCount: enriched.length,
          videoCount: enriched.reduce((total, item) => total + (item.count || 0), 0),
        })
        return { ...context, series: enriched }
      } catch (error) {
        // Same property read as before: non-Error throws still fail the same way.
        const message = (error as Error).message
        statistics.set(library.id, { root: library.root, at: Date.now(), error: message })
        return {
          ...context, available: false, series: [],
          error: `无法读取媒体库“${library.name}”：${library.root}（${message}）`,
        }
      }
    },
    async series(pathValue?: string, libraryId?: string): Promise<LibrarySeriesDetail> {
      const library = resolveLibrary(libraryId)
      if (typeof pathValue !== 'string' || !pathValue.trim()) throw new HttpError(400, '缺少作品路径')
      const requested = '/' + pathValue.replace(/^\/+|\/+$/g, '')
      if (requested === '/') throw new HttpError(400, '作品路径不能是媒体库根目录')
      const decoded = decodePath(requested)
      const catalog = await scanLibrary(library.id)
      const entry = catalog.find((item) => decodePath(item.path) === decoded)
      if (!entry) throw new HttpError(404, '作品不存在')
      const virtualPath = entry.path
      const absolute = resolveVirtual(virtualPath, library.id)
      const relRoot = relOf(virtualPath)
      const bindings = bindingsFor(library.id)
        .filter((binding) => binding.folderPath === relRoot || binding.folderPath.startsWith(relRoot + '/'))
        .sort((a, b) => a.folderPath.length - b.folderPath.length || a.folderPath.localeCompare(b.folderPath, 'zh-CN'))
      const mediaById = mediaOf(bindings)
      const media = [...new Set(bindings.map((binding) => binding.mediaId))]
        .map((id) => mediaById.get(id))
        .filter((item): item is Media => Boolean(item))
      const videos: SeriesVideo[] = []
      const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > 6 || videos.length >= 2000) return
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
        for (const item of entries) {
          if (item.name.startsWith('.')) continue
          const target = path.join(directory, item.name)
          if (item.isDirectory()) {
            await walk(target, depth + 1)
            continue
          }
          if (!item.isFile() || !VIDEO_EXTS.has(path.extname(item.name).toLowerCase())) continue
          const stat = await fs.stat(target).catch(() => null)
          if (!stat) continue
          const videoPath = toVirtual(target, library.id)
          const directoryRel = relOf(videoPath).split('/').slice(0, -1).join('/')
          const binding = bindings
            .filter((item) => directoryRel === item.folderPath || directoryRel.startsWith(item.folderPath + '/'))
            .sort((a, b) => b.folderPath.length - a.folderPath.length)[0]
          const subPath = directoryRel === relRoot ? '' : directoryRel.slice(relRoot.length + 1)
          videos.push({
            name: item.name,
            path: videoPath,
            seasonPath: subPath ? '/' + subPath.split('/').map(encodeURIComponent).join('/') : virtualPath,
            seasonName: subPath || '全部剧集',
            mediaId: binding?.mediaId ?? null,
            size: stat.size,
            mtime: stat.mtimeMs,
          })
        }
      }
      if (entry.kind === 'dir') {
        await walk(absolute, 0)
        videos.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }))
      } else {
        const stat = await fs.stat(absolute).catch(() => null)
        if (stat) {
          const binding = bindings.find((item) => item.folderPath === relRoot)
          videos.push({
            name: entry.name, path: virtualPath, seasonPath: '', seasonName: '全部剧集',
            mediaId: binding?.mediaId ?? null, size: stat.size, mtime: stat.mtimeMs,
          })
        }
      }
      return {
        libraryId: library.id,
        libraryName: library.name,
        path: virtualPath,
        name: entry.name,
        kind: entry.kind,
        count: entry.count,
        poster: 'poster' in entry ? entry.poster : null,
        media,
        videos,
      }
    },
    async list(directory?: string, libraryId?: string): Promise<LibraryDirectory> {
      const library = resolveLibrary(libraryId)
      const virtualPath = directory ? (directory.startsWith('/') ? directory : '/' + directory) : '/'
      return {
        path: virtualPath, root: library.root, libraryId: library.id, libraryName: library.name,
        items: await listDirectory(virtualPath, library.id),
      }
    },
  }
}
