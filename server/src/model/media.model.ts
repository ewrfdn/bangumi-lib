import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import type { Dirent, ReadStream, Stats } from 'node:fs'
import { config } from '../config.ts'
import { HttpError } from '../errors.ts'
import type { LibraryId } from '../types.ts'

export const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.m4v', '.webm', '.mov', '.avi', '.ts', '.m2ts', '.mts',
  '.flv', '.wmv', '.rmvb', '.rm', '.mpg', '.mpeg', '.ogv', '.3gp', '.vob',
  '.iso', '.divx',
])
export const SUBTITLE_EXTS = new Set(['.ass', '.ssa', '.srt', '.vtt', '.sup', '.sub', '.idx'])
/** Sup/idx 是图形字幕，无法转成文本，只能 burned-in */
export const IMAGE_SUB_EXTS = new Set(['.sup', '.sub', '.idx'])
export const AUDIO_EXTS = new Set(['.flac', '.mp3', '.m4a', '.aac', '.opus', '.ogg', '.wav'])

export type MediaKind = 'dir' | 'video' | 'subtitle' | 'audio' | 'other'

/** A single directory listing row: counts/posters belong to directories, size/mtime to files. */
export interface MediaEntry {
  name: string
  path: string
  libraryId: LibraryId
  kind: MediaKind
  ext: string
  count?: number | null
  poster?: string | null
  size?: number
  mtime?: number
}

/** A shallow library scan hit: a standalone video or a series directory. */
export interface ScanItem {
  name: string
  path: string
  libraryId: LibraryId
  kind: 'dir' | 'video'
  count: number
}

export interface ScanSeries extends ScanItem {
  kind: 'dir'
  poster: string | null
  items: ScanItem[]
}

export type ScanEntry = ScanItem | ScanSeries

/** Byte bounds for a stream; Node accepts either bound on its own. */
export interface StreamRange {
  start?: number
  end?: number
}

export interface FileResource {
  absolutePath: string
  name: string
  ext: string
  size: number
  mtime: Date
  open(range?: StreamRange): ReadStream
}

/** 把 API 里的虚拟路径（/a/b.mkv）解析为根目录内的真实绝对路径，并防止目录穿越 */
function outside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
}

function assertRealPathInside(root: string, candidate: string): void {
  if (!fsSync.existsSync(root)) return
  const realRoot = fsSync.realpathSync(root)
  let existing = candidate
  while (!fsSync.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  if (outside(realRoot, fsSync.realpathSync(existing))) throw new HttpError(403, '禁止通过软链接访问媒体库之外的文件')
}

export function resolveVirtual(virtualPath: string, libraryId: LibraryId = config.defaultLibraryId): string {
  const root = config.getLibrary(libraryId).root
  if (typeof virtualPath !== 'string' || !virtualPath.startsWith('/')) {
    throw new HttpError(400, '路径必须以 / 开头')
  }
  let decoded: string
  try { decoded = decodeURIComponent(virtualPath) } catch { throw new HttpError(400, '非法路径编码') }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) throw new HttpError(400, '非法路径')
  if (decoded.split('/').includes('..')) throw new HttpError(403, '禁止访问媒体库之外的文件')
  const abs = path.resolve(root, '.' + path.posix.normalize(decoded))
  if (outside(root, abs)) {
    throw new HttpError(403, '禁止访问根目录之外的文件')
  }
  assertRealPathInside(root, abs)
  return abs
}

export function toVirtual(absPath: string, libraryId: LibraryId = config.defaultLibraryId): string {
  const root = config.getLibrary(libraryId).root
  if (outside(root, absPath)) throw new HttpError(403, '禁止访问媒体库之外的文件')
  const rel = path.relative(root, absPath)
  const parts = rel.split(path.sep).filter(Boolean).map(encodeURIComponent)
  return '/' + parts.join('/')
}

export function extOf(name: string): string {
  return path.extname(name).toLowerCase()
}

export function kindOf(name: string, isDir: boolean): MediaKind {
  if (isDir) return 'dir'
  const ext = extOf(name)
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (SUBTITLE_EXTS.has(ext)) return 'subtitle'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return 'other'
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b)

/** 去掉常见发布组后缀，用于匹配字幕 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[._\-\s]+/g, ' ')
    .trim()
}

function episodeKey(name: string): string {
  const base = name.toLowerCase()
  const sxe = base.match(/s(\d{1,2})e(\d{1,3})/)
  if (sxe) return `s${Number(sxe[1])}e${Number(sxe[2])}`
  const m = base.match(/(?:^|[\s._\-[\]【】第])(\d{1,4})(?:v\d)?(?:[\s._\-[\]】]|$)/)
  return m ? `e${Number(m[1])}` : ''
}

/** 找出视频对应的外挂字幕文件列表 */
export function findSubtitlesFor(videoName: string, allFiles: readonly MediaEntry[]): MediaEntry[] {
  const base = normalizeName(videoName)
  const ep = episodeKey(videoName)
  return allFiles
    .filter((f) => f.kind === 'subtitle')
    .map((f) => ({
      file: f,
      subBase: normalizeName(f.name),
      subEp: episodeKey(f.name),
    }))
    .filter(({ subBase, subEp }) => {
      if (!base || !subBase) return false
      // 1) 前缀/包含关系 2) 集数一致且名字有交集
      if (subBase.startsWith(base) || base.startsWith(subBase) || base.includes(subBase)) return true
      // 2) 集数一致（S01E02 / 第2话 / [02]）
      if (ep && subEp && ep === subEp) return true
      // 3) 同目录下只有一个视频且只有一个文本字幕时，视为该视频的字幕
      return false
    })
    .map(({ file }) => file)
}

/**
 * 兜底：目录里只有一个视频 + 若干字幕时，全部视为该视频的外挂字幕
 * （很多番剧组的字幕文件名与视频名不完全一致）
 */
export function fallbackSubtitles(videoFiles: readonly MediaEntry[], allFiles: readonly MediaEntry[]): MediaEntry[] {
  if (videoFiles.length !== 1) return []
  return allFiles.filter((f) => f.kind === 'subtitle')
}
async function safeStat(p: string): Promise<Stats | null> {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

/** 列表某个目录（不递归）。隐藏文件和 .torrent 等不计入媒体 */
export async function listDirectory(virtualDir: string, libraryId: LibraryId = config.defaultLibraryId): Promise<MediaEntry[]> {
  const abs = resolveVirtual(virtualDir, libraryId)
  let entries: Dirent[]
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new HttpError(404, '目录不存在')
    if (code === 'EACCES') throw new HttpError(403, '没有读取权限')
    throw err
  }

  const items: MediaEntry[] = []
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const childAbs = path.join(abs, ent.name)
    try { resolveVirtual(toVirtual(childAbs, libraryId), libraryId) } catch { continue }
    let isDir = ent.isDirectory()
    // 处理软链接
    if (ent.isSymbolicLink()) {
      const st = await safeStat(childAbs)
      if (!st) continue
      isDir = st.isDirectory()
    }
    const kind = kindOf(ent.name, isDir)
    if (kind === 'other') continue
    const item: MediaEntry = {
      name: ent.name,
      path: toVirtual(childAbs, libraryId),
      libraryId,
      kind,
      ext: isDir ? '' : extOf(ent.name),
    }
    if (isDir) {
      item.count = await countVideos(childAbs, 3, libraryId)
      item.poster = await findPoster(childAbs, 2, libraryId)
    } else {
      const st = await safeStat(childAbs)
      item.size = st?.size ?? 0
      item.mtime = st?.mtimeMs ?? 0
    }
    items.push(item)
  }

  // 目录在前，再按自然排序（数字 1,2,10 正确）
  items.sort((a, b) => {
    if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1
    return naturalCompare(a.name, b.name)
  })
  return items
}

const POSTER_NAMES = ['poster', 'cover', 'folder', 'fanart', 'thumb', 'banner']
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif'])

/** 在目录里找封面图：poster.* / cover.* / folder.* / fanart.* 优先，其次任意图片 */
export async function findPoster(absDir: string, depth = 2, libraryId: LibraryId = config.defaultLibraryId): Promise<string | null> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return null
  }
  const images = entries.filter((e) => e.isFile() && IMG_EXTS.has(extOf(e.name)))
  for (const key of POSTER_NAMES) {
    const hit = images.find((e) => e.name.toLowerCase().startsWith(key))
    if (hit) return toVirtual(path.join(absDir, hit.name), libraryId)
  }
  if (images.length) return toVirtual(path.join(absDir, images[0].name), libraryId)
  if (depth <= 1) return null
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const found = await findPoster(path.join(absDir, e.name), depth - 1, libraryId)
    if (found) return found
  }
  return null
}

async function countVideos(absDir: string, depth: number, libraryId: LibraryId = config.defaultLibraryId): Promise<number | null> {
  if (depth <= 0) return null
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    let n = 0
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) n += (await countVideos(path.join(absDir, e.name), depth - 1, libraryId)) || 0
      else if (VIDEO_EXTS.has(extOf(e.name))) n++
    }
    return n
  } catch {
    return 0
  }
}

/** 浅层扫描整个根目录：番剧名 -> 封面/视频数 */
export async function scanLibrary(libraryId: LibraryId = config.defaultLibraryId): Promise<ScanEntry[]> {
  const root = config.getLibrary(libraryId).root
  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new HttpError(code === 'EACCES' ? 403 : 404, '媒体库目录不存在或无法读取')
  }
  const result: ScanEntry[] = []
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const abs = path.join(root, ent.name)
    try { resolveVirtual(toVirtual(abs, libraryId), libraryId) } catch { continue }
    if (!ent.isDirectory()) {
      if (kindOf(ent.name, false) === 'video') {
        result.push({ name: ent.name, path: toVirtual(abs, libraryId), libraryId, kind: 'video', count: 1 })
      }
      continue
    }
    const series: ScanSeries = {
      name: ent.name,
      path: toVirtual(abs, libraryId),
      libraryId,
      kind: 'dir',
      poster: null,
      count: 0,
      items: [],
    }
    // 只扫两层：番剧/Season X/视频
    const subs = await fs.readdir(abs, { withFileTypes: true }).catch((): Dirent[] => [])
    for (const sub of subs) {
      if (sub.name.startsWith('.')) continue
      const subAbs = path.join(abs, sub.name)
      if (sub.isDirectory()) {
        const videos = (await fs.readdir(subAbs).catch(() => [])).filter((n) => VIDEO_EXTS.has(extOf(n)))
        series.count += videos.length
        if (videos.length) series.items.push({ name: sub.name, path: toVirtual(subAbs, libraryId), libraryId, count: videos.length, kind: 'dir' })
      } else {
        const imgExt = extOf(sub.name)
        if (IMG_EXTS.has(imgExt) && !series.poster) {
          series.poster = toVirtual(subAbs, libraryId)
        }
        if (VIDEO_EXTS.has(imgExt)) {
          series.count++
          // 视频直接在番剧根目录：作为一个“全部剧集”入口
          if (!series.items.some((i) => i.path === toVirtual(abs, libraryId))) {
            series.items.push({ name: '全部剧集', path: toVirtual(abs, libraryId), libraryId, count: series.count, kind: 'dir' })
          }
        }
      }
    }
    if (!series.poster) series.poster = await findPoster(abs, 2, libraryId)
    result.push(series)
  }
  result.sort((a, b) => naturalCompare(a.name, b.name))

  // 如果根目录只有一个目录，自动下钻一层，避免首页只有一个卡片
  if (result.length === 1 && result[0].kind === 'dir') return result
  return result
}

export async function assertFile(abs: string): Promise<Stats> {
  const st = await safeStat(abs)
  if (!st) throw new HttpError(404, '文件不存在')
  if (!st.isFile()) throw new HttpError(400, '不是文件')
  return st
}

export async function directoryAvailable(directory: string): Promise<boolean> {
  return fs.stat(directory).then((stat) => stat.isDirectory(), () => false)
}

export function directoryAvailableSync(directory: string): boolean {
  try { return fsSync.statSync(directory).isDirectory() } catch { return false }
}

/** File access remains in the model; transport code receives metadata and a stream factory. */
export function fileResource(virtualPath: string, libraryId: LibraryId = config.defaultLibraryId): FileResource {
  const absolutePath = resolveVirtual(virtualPath, libraryId)
  let stat: Stats
  try { stat = fsSync.statSync(absolutePath) }
  catch { throw new HttpError(404, '文件不存在') }
  if (!stat.isFile()) throw new HttpError(400, '不是文件')
  return {
    absolutePath,
    name: path.basename(absolutePath),
    ext: extOf(absolutePath),
    size: stat.size,
    mtime: stat.mtime,
    open: (range: StreamRange = {}): ReadStream => fsSync.createReadStream(absolutePath, { highWaterMark: 1024 * 1024, ...range }),
  }
}

export async function readTextFile(absolutePath: string): Promise<string> {
  return fs.readFile(absolutePath, 'utf8')
}

export interface CachedSegment {
  size: number
  open(): ReadStream
}

export async function cachedSegmentResource(absolutePath: string): Promise<CachedSegment | null> {
  const stat = await fs.stat(absolutePath).catch(() => null)
  if (!stat?.isFile()) return null
  return { size: stat.size, open: () => fsSync.createReadStream(absolutePath) }
}
