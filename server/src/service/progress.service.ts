import { HttpError } from '../errors.ts'
import { resolveVirtual, toVirtual } from '../model/media.model.ts'
import { config } from '../config.ts'
import type { ProgressInput } from '../model/database.ts'
import type { AniShareDatabase } from '../model/database.ts'
import type { AppConfig, PlaybackProgress } from '../types.ts'

export interface ProgressService {
  list(libraryId?: string): PlaybackProgress[]
  save(record: unknown): PlaybackProgress | null
  import(items: unknown): PlaybackProgress[]
  remove(itemPath: unknown, libraryId?: string): { ok: boolean }
}

function virtualPath(value: unknown, libraryId: string, field = 'path', allowRoot = false): string {
  if (typeof value !== 'string' || value.length > 8192 || (!allowRoot && value === '/')) throw new HttpError(400, `${field} 无效`)
  try {
    return toVirtual(resolveVirtual(value, libraryId), libraryId)
  } catch {
    throw new HttpError(400, `${field} 无效`)
  }
}

function deletionPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.length > 8192) throw new HttpError(400, 'path 无效')
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { throw new HttpError(400, 'path 无效') }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':') || decoded.split('/').includes('..')) throw new HttpError(400, 'path 无效')
  return '/' + decoded.split('/').filter((part) => part && part !== '.').map(encodeURIComponent).join('/')
}

function validateProgress(value: unknown, settings: AppConfig): ProgressInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '播放记录无效')
  // 动态 JSON：下面逐字段校验，校验通过后才读取。
  const record = value as Record<string, unknown>
  const { time, duration } = record
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 ||
      typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 7 * 86400) {
    throw new HttpError(400, '播放时间或视频时长无效')
  }
  if (record.title !== undefined && (typeof record.title !== 'string' || record.title.length > 1000)) throw new HttpError(400, '标题无效')
  if (record.seriesTitle != null && (typeof record.seriesTitle !== 'string' || record.seriesTitle.length > 1000)) throw new HttpError(400, '番剧标题无效')
  if (record.poster != null && typeof record.poster !== 'string') throw new HttpError(400, 'poster 无效')
  if (record.seriesPath != null && typeof record.seriesPath !== 'string') throw new HttpError(400, 'seriesPath 无效')
  if (record.at !== undefined && (typeof record.at !== 'number' || !Number.isSafeInteger(record.at) || record.at <= 0)) throw new HttpError(400, '记录时间无效')
  if (record.libraryId !== undefined && (typeof record.libraryId !== 'string' || !record.libraryId)) throw new HttpError(400, '媒体库无效')
  const library = settings.getLibrary(typeof record.libraryId === 'string' ? record.libraryId : undefined)
  const itemPath = virtualPath(record.path, library.id)
  const title = typeof record.title === 'string' ? record.title : ''
  const seriesTitle = typeof record.seriesTitle === 'string' ? record.seriesTitle : ''
  const at = typeof record.at === 'number' ? record.at : undefined
  return {
    libraryId: library.id,
    path: itemPath,
    title: title || decodeURIComponent(itemPath.split('/').pop()!),
    time: Math.min(time, duration),
    duration,
    at: Math.min(at || Date.now(), Date.now()),
    hevc: Boolean(record.hevc),
    poster: typeof record.poster === 'string' && record.poster ? virtualPath(record.poster, library.id, 'poster') : null,
    seriesPath: typeof record.seriesPath === 'string' && record.seriesPath ? virtualPath(record.seriesPath, library.id, 'seriesPath', true) : null,
    seriesTitle: seriesTitle || null,
  }
}

export function createProgressService(database: AniShareDatabase, settings: AppConfig = config): ProgressService {
  return {
    list(libraryId?: string): PlaybackProgress[] {
      return database.listProgress(libraryId === undefined ? undefined : settings.getLibrary(libraryId).id)
    },
    save(record: unknown): PlaybackProgress | null {
      return database.writeProgress(validateProgress(record, settings))
    },
    import(items: unknown): PlaybackProgress[] {
      if (!Array.isArray(items) || items.length > 500) throw new HttpError(400, '最多导入 500 条播放记录')
      database.importProgress(items.map((item) => validateProgress(item, settings)))
      return database.listProgress()
    },
    remove(itemPath: unknown, libraryId: string = settings.defaultLibraryId): { ok: boolean } {
      if (typeof libraryId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(libraryId)) throw new HttpError(400, '媒体库无效')
      const canonical = deletionPath(itemPath)
      if (!database.getProgress(canonical, libraryId)) settings.getLibrary(libraryId)
      database.deleteProgress(canonical, libraryId)
      return { ok: true }
    },
  }
}
