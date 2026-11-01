import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

export const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.m4v', '.webm', '.mov', '.avi', '.ts', '.m2ts', '.mts',
  '.flv', '.wmv', '.rmvb', '.rm', '.mpg', '.mpeg', '.ogv', '.3gp', '.vob',
  '.iso', '.divx',
])
export const SUBTITLE_EXTS = new Set(['.ass', '.ssa', '.srt', '.vtt', '.sup', '.sub', '.idx'])
/** Sup/idx 是图形字幕，无法转成文本，只能 burned-in */
export const IMAGE_SUB_EXTS = new Set(['.sup', '.sub', '.idx'])
export const AUDIO_EXTS = new Set(['.flac', '.mp3', '.m4a', '.aac', '.opus', '.ogg', '.wav'])

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** 把 API 里的虚拟路径（/a/b.mkv）解析为根目录内的真实绝对路径，并防止目录穿越 */
export function resolveVirtual(virtualPath) {
  if (typeof virtualPath !== 'string' || !virtualPath.startsWith('/')) {
    throw new HttpError(400, '路径必须以 / 开头')
  }
  const decoded = decodeURIComponent(virtualPath)
  if (decoded.includes('\0')) throw new HttpError(400, '非法路径')
  const root = config.mediaRoot
  const abs = path.resolve(root, '.' + path.posix.normalize(decoded))
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new HttpError(403, '禁止访问根目录之外的文件')
  }
  return abs
}

export function toVirtual(absPath) {
  const rel = path.relative(config.mediaRoot, absPath)
  const parts = rel.split(path.sep).filter(Boolean).map(encodeURIComponent)
  return '/' + parts.join('/')
}

export function extOf(name) {
  return path.extname(name).toLowerCase()
}

export function kindOf(name, isDir) {
  if (isDir) return 'dir'
  const ext = extOf(name)
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (SUBTITLE_EXTS.has(ext)) return 'subtitle'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return 'other'
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
export const naturalCompare = (a, b) => collator.compare(a, b)

/** 去掉常见发布组后缀，用于匹配字幕 */
function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[._\-\s]+/g, ' ')
    .trim()
}

function episodeKey(name) {
  const base = name.toLowerCase()
  const sxe = base.match(/s(\d{1,2})e(\d{1,3})/)
  if (sxe) return `s${Number(sxe[1])}e${Number(sxe[2])}`
  const m = base.match(/(?:^|[\s._\-[\]【】第])(\d{1,4})(?:v\d)?(?:[\s._\-[\]】]|$)/)
  return m ? `e${Number(m[1])}` : ''
}

/** 找出视频对应的外挂字幕文件列表 */
export function findSubtitlesFor(videoName, allFiles) {
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
export function fallbackSubtitles(videoFiles, allFiles) {
  if (videoFiles.length !== 1) return []
  return allFiles.filter((f) => f.kind === 'subtitle')
}
async function safeStat(p) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

/** 列表某个目录（不递归）。隐藏文件和 .torrent 等不计入媒体 */
export async function listDirectory(virtualDir) {
  const abs = resolveVirtual(virtualDir)
  let entries
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, '目录不存在')
    if (err.code === 'EACCES') throw new HttpError(403, '没有读取权限')
    throw err
  }

  const items = []
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const childAbs = path.join(abs, ent.name)
    let isDir = ent.isDirectory()
    // 处理软链接
    if (ent.isSymbolicLink()) {
      const st = await safeStat(childAbs)
      if (!st) continue
      isDir = st.isDirectory()
    }
    const kind = kindOf(ent.name, isDir)
    if (kind === 'other') continue
    const item = {
      name: ent.name,
      path: toVirtual(childAbs),
      kind,
      ext: isDir ? '' : extOf(ent.name),
    }
    if (isDir) {
      item.count = await countVideos(childAbs, 3)
      item.poster = await findPoster(childAbs)
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
export async function findPoster(absDir, depth = 2) {
  let entries
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return null
  }
  const images = entries.filter((e) => e.isFile() && IMG_EXTS.has(extOf(e.name)))
  for (const key of POSTER_NAMES) {
    const hit = images.find((e) => e.name.toLowerCase().startsWith(key))
    if (hit) return toVirtual(path.join(absDir, hit.name))
  }
  if (images.length) return toVirtual(path.join(absDir, images[0].name))
  if (depth <= 1) return null
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const found = await findPoster(path.join(absDir, e.name), depth - 1)
    if (found) return found
  }
  return null
}

async function countVideos(absDir, depth, self = null) {
  if (depth <= 0) return null
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    let n = 0
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) n += (await countVideos(path.join(absDir, e.name), depth - 1)) || 0
      else if (VIDEO_EXTS.has(extOf(e.name))) n++
    }
    return n
  } catch {
    return 0
  }
}

/** 浅层扫描整个根目录：番剧名 -> 封面/视频数 */
export async function scanLibrary() {
  const root = config.mediaRoot
  let entries = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const result = []
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const abs = path.join(root, ent.name)
    if (!ent.isDirectory()) {
      if (kindOf(ent.name, false) === 'video') {
        result.push({ name: ent.name, path: toVirtual(abs), kind: 'video', count: 1 })
      }
      continue
    }
    const series = {
      name: ent.name,
      path: toVirtual(abs),
      kind: 'dir',
      poster: null,
      count: 0,
      items: [],
    }
    // 只扫两层：番剧/Season X/视频
    const subs = await fs.readdir(abs, { withFileTypes: true }).catch(() => [])
    for (const sub of subs) {
      if (sub.name.startsWith('.')) continue
      const subAbs = path.join(abs, sub.name)
      if (sub.isDirectory()) {
        const videos = (await fs.readdir(subAbs).catch(() => [])).filter((n) => VIDEO_EXTS.has(extOf(n)))
        series.count += videos.length
        if (videos.length) series.items.push({ name: sub.name, path: toVirtual(subAbs), count: videos.length, kind: 'dir' })
      } else {
        const imgExt = extOf(sub.name)
        if (IMG_EXTS.has(imgExt) && !series.poster) {
          series.poster = toVirtual(subAbs)
        }
        if (VIDEO_EXTS.has(imgExt)) {
          series.count++
          // 视频直接在番剧根目录：作为一个“全部剧集”入口
          if (!series.items.some((i) => i.path === toVirtual(abs))) {
            series.items.push({ name: '全部剧集', path: toVirtual(abs), count: series.count, kind: 'dir' })
          }
        }
      }
    }
    if (!series.poster) series.poster = await findPoster(abs, 2)
    result.push(series)
  }
  result.sort((a, b) => naturalCompare(a.name, b.name))

  // 如果根目录只有一个目录，自动下钻一层，避免首页只有一个卡片
  if (result.length === 1 && result[0].kind === 'dir') return result
  return result
}

export async function assertFile(abs) {
  const st = await safeStat(abs)
  if (!st) throw new HttpError(404, '文件不存在')
  if (!st.isFile()) throw new HttpError(400, '不是文件')
  return st
}
