import path from 'node:path'

export type VideoType = 'main' | 'extra'

export interface VideoClassification {
  videoType: VideoType
  videoIndex: number
}

export interface VideoClassificationOptions {
  /** Bangumi 等资料源给出的总集数；0/null 表示未知。 */
  episodeCount?: number | null
}

export interface ClassifiableVideo {
  mediaPath: string
}

/** 特典/花絮目录名（整段匹配，避免误伤 SPY×FAMILY 这类标题）。 */
const SPECIAL_DIRECTORIES = new Set([
  '特典', '映像特典', '特別映像', '特别映像', '特番', '花絮', '映像',
  'sp', 'sps', 'special', 'specials', 'extra', 'extras',
  'ncop', 'nced', 'pv', 'pvs', 'cm', 'menu', 'menus', 'talk', 'talks',
  'interview', 'interviews', 'bonus', 'preview', 'previews', 'teaser', 'teasers',
  'live', 'event', 'events', 'op', 'ed', 'mad', 'iv', 'oad', 'ova', 'ona',
])

/** 文件名里的特典/花絮标记；OP/ED 只认 NCOP/NCED，避免误伤正文标题。 */
const SPECIAL_NAME = new RegExp([
  '特典', '映像特典', '特別映像', '特别映像', '花絮',
  '(?<![a-z])ncop(?![a-z])', '(?<![a-z])nced(?![a-z])',
  '(?<![a-z])pvs?(?![a-z])', '(?<![a-z])cm(?![a-z])', '(?<![a-z])menus?(?![a-z])',
  '(?<![a-z])talks?(?![a-z])', '(?<![a-z])interviews?(?![a-z])',
  '(?<![a-z])bonus(?![a-z])', '(?<![a-z])previews?(?![a-z])', '(?<![a-z])teasers?(?![a-z])',
  '(?<![a-z])mads?(?![a-z])', '(?<![a-z])iv(?![a-z])', '(?<![a-z])oad(?![a-z])', '(?<![a-z])ova(?![a-z])',
  '(?<![a-z])sp(?![a-z])',
  'character\\s*pv', 'lyric\\s*video', 'road\\s*to', 'special\\s*studio', 'web\\s*preview',
].join('|'), 'i')

const isSpecialDirectory = (segment: string): boolean => SPECIAL_DIRECTORIES.has(segment.toLowerCase())

const toNumber = (whole: string, fraction?: string): number | null => {
  const value = Number(`${whole}${fraction ? `.${fraction}` : ''}`)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 从文件名解析集号，支持 SxxExx、第 x 集、` - 12.5 `、`EP12` 等常见写法。
 * 解析不出或只有分辨率信息时返回 null。
 */
export function parseEpisodeNumber(name: string): number | null {
  const base = path.parse(name).name
  // 先剥掉季号，避免 "Season 2 - 01" 被解析成第 2 集。
  const cleaned = base
    .replace(/\b(?:season|series)\s*\d{1,2}\b/gi, ' ')
    .replace(/(?:^|[\s._-])s\d{1,2}(?=$|[\s._-])/gi, ' ')

  let match = /[Ss](\d{1,2})[Ee](\d{1,4})(?:\.(\d+))?/.exec(cleaned)
  if (match) return toNumber(match[2], match[3])

  match = /第\s*(\d{1,4})(?:\.(\d+))?\s*[集话話]/.exec(cleaned)
  if (match) return toNumber(match[1], match[2])

  match = /(?:^|[\s._\-\[\(])(?:EP?|Episode)\s*(\d{1,4})(?:\.(\d+))?/i.exec(cleaned)
  if (match) return toNumber(match[1], match[2])

  // 正文常见的 "标题 - 01" / "标题 01 [1080p]"；排除 720p/1080p 等分辨率。
  match = /(?:^|[\s._\-\[\(])(\d{1,3})(?:\.(\d+))?(?![\dPp])(?=\s*(?:\[|\(|$|[-_.\s]))/.exec(cleaned)
  if (match) return toNumber(match[1], match[2])

  return null
}

/** 是否为特典/花絮：所在目录或文件名带特典标记。 */
export function isSpecialVideo(mediaPath: string): boolean {
  const normalized = mediaPath.replace(/\\/g, '/')
  const directories = normalized.split('/').slice(0, -1)
  if (directories.some(isSpecialDirectory)) return true
  return SPECIAL_NAME.test(path.posix.basename(normalized))
}

/**
 * 根据 Bangumi 总集数把视频分成正片和番外：
 * - 正片：不带特典标记、集号是 1..总集数 的整数集（如 1、2、12）。
 * - 番外：特典目录/文件名、集号不在总集数范围内、非整数集号（如 11.5）。
 * - 总集数未知时，带特典标记的算番外，其余算正片。
 * - 总集数已知但所有文件都解析不出集号时，按目录顺序取前 N 个非特典文件作为正片。
 * 番外的 videoIndex 排在正片之后（总集数 + 小数序号），仍保持可排序且不冲突。
 */
export function classifyVideos(
  files: ClassifiableVideo[],
  { episodeCount }: VideoClassificationOptions = {},
): Map<string, VideoClassification> {
  const total = Number.isFinite(episodeCount) && Number(episodeCount) > 0 ? Math.trunc(Number(episodeCount)) : 0
  const entries = files.map((file) => {
    const name = path.posix.basename(file.mediaPath.replace(/\\/g, '/'))
    const parsed = parseEpisodeNumber(name)
    const special = isSpecialVideo(file.mediaPath)
    return { mediaPath: file.mediaPath, parsed, special, main: false }
  })

  const hasStrictMain = entries.some((entry) => !entry.special && entry.parsed !== null
    && Number.isInteger(entry.parsed) && entry.parsed >= 1 && (total === 0 || entry.parsed <= total))

  for (const entry of entries) {
    if (entry.special) continue
    if (entry.parsed !== null) {
      entry.main = Number.isInteger(entry.parsed) && entry.parsed >= 1 && (total === 0 || entry.parsed <= total)
      continue
    }
    // 总集数未知时，非特典文件默认是正片；已知时留给下面的顺序兜底。
    entry.main = total === 0
  }

  // 总集数已知且没有任何文件能严格对上集号：把非特典、非小数集号的文件
  // 按顺序当作正片（覆盖文件名带年份的电影、13..24 这种从中间开始的目录）。
  if (total > 0 && !hasStrictMain) {
    const candidates = entries.filter((entry) => !entry.special
      && (entry.parsed === null || Number.isInteger(entry.parsed)))
    if (candidates.length > 0 && candidates.length <= total) {
      let ordinal = 1
      for (const entry of candidates) {
        entry.main = true
        if (entry.parsed === null || entry.parsed < 1 || entry.parsed > total) entry.parsed = ordinal
        ordinal += 1
      }
    }
  }

  let mainOrdinal = 0
  let maxMainIndex = 0
  for (const entry of entries) {
    if (!entry.main) continue
    mainOrdinal += 1
    const index = entry.parsed !== null && Number.isInteger(entry.parsed) && entry.parsed >= 1
      ? entry.parsed
      : mainOrdinal
    if (entry.parsed === null) entry.parsed = index
    maxMainIndex = Math.max(maxMainIndex, index)
  }

  const base = total || maxMainIndex
  let extraOrdinal = 0
  const result = new Map<string, VideoClassification>()
  for (const entry of entries) {
    if (entry.main) {
      result.set(entry.mediaPath, { videoType: 'main', videoIndex: entry.parsed ?? ++mainOrdinal })
      continue
    }
    extraOrdinal += 1
    result.set(entry.mediaPath, { videoType: 'extra', videoIndex: Number((base + extraOrdinal / 100).toFixed(2)) })
  }
  return result
}
