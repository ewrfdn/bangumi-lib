async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text.slice(0, 200) }
  }
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败 (${res.status})`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

const q = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

export const api = {
  status: () => getJSON('/api/status'),
  library: () => getJSON('/api/library'),
  list: (path) => getJSON(`/api/list?${q({ path })}`),
  video: (path) => getJSON(`/api/video?${q({ path })}`),

  streamUrl: (path) => `/api/stream?${q({ path })}`,
  fileUrl: (path) => `/api/file?${q({ path })}`,
  subtitleUrl: (path) => `/api/subtitle?${q({ path })}`,
  streamSubtitleUrl: (path, index) => `/api/stream-subtitle?${q({ path, index })}`,
  hlsStart: (path, t = 0) => getJSON(`/api/hls/start?${q({ path, t: Math.max(0, Math.floor(t)) })}`),
  hlsStop: (id) => fetch(`/api/hls/${id}`, { method: 'DELETE' }).catch(() => {}),
}

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

export function fmtTime(sec, { withHours } = {}) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  const pad = (n) => String(n).padStart(2, '0')
  if (h > 0 || withHours) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

export function fmtDate(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const CODEC_LABEL = {
  h264: 'H.264',
  hevc: 'H.265',
  h265: 'H.265',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  aac: 'AAC',
  ac3: 'AC3',
  eac3: 'E-AC3',
  dts: 'DTS',
  truehd: 'TrueHD',
  flac: 'FLAC',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  pcm_s16le: 'PCM',
  ass: 'ASS',
  ssa: 'SSA',
  subrip: 'SRT',
  mov_text: 'TX3G',
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
}
export const codecLabel = (c) => CODEC_LABEL[c] || (c ? c.toUpperCase() : '')

export const LANG_LABEL = {
  'zh-CN': '简中',
  'zh-TW': '繁中',
  zh: '中文',
  ja: '日语',
  jpn: '日语',
  en: '英语',
  eng: '英语',
}
export const langLabel = (l) => LANG_LABEL[l] || LANG_LABEL[l?.toLowerCase?.()] || l || ''

/** 从文件名里猜一个可读标题（去掉组名、编码信息、扩展名） */
export function prettyTitle(name) {
  if (!name) return ''
  let s = name.replace(/\.[^.]+$/, '')
  // 去掉 [xxx] 和 【xxx】
  s = s.replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）/g, ' ')
  // 去掉常见编码/来源词
  s = s.replace(
    /\b(1080p?|720p?|2160p?|4k|hevc|h\.?26[45]|avc|x26[45]|10bit|8bit|aac|flac|web-?dl|webrip|blu-?ray|bdrip|bd|hdr|hi10p|chs|cht|jpn|eng|sc|tc|gb|big5|ma10p|v\d)\b/gi,
    ' ',
  )
  s = s.replace(/\bS\d{1,2}E\d{1,3}\b/gi, (m) => m.toUpperCase())
  s = s.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s || name
}

/** 从文件名里解析集数 SxxExx / 第x话 / [xx] */
export function parseEpisode(name) {
  const n = name || ''
  let m = n.match(/S(\d{1,2})E(\d{1,3})/i)
  if (m) return { season: +m[1], episode: +m[2] }
  m = n.match(/第\s*(\d{1,4})\s*[话話集]/)
  if (m) return { episode: +m[1] }
  m = n.match(/\[(\d{1,3})(?:v\d)?\]/)
  if (m) return { episode: +m[1] }
  m = n.match(/[-–_ ](\d{1,3})(?:v\d)?(?=[\s.[\]]|$)/)
  if (m) return { episode: +m[1] }
  return {}
}

/** 稳定地从字符串生成一个主题色（用于无封面时的渐变占位） */
export function hueFrom(str) {
  let h = 0
  for (let i = 0; i < (str || '').length; i++) h = (h * 31 + str.charCodeAt(i)) % 360
  // 偏向冷色系（紫/蓝/青/粉），与整体 UI 更协调，并拉大色相差
  const bases = [255, 205, 170, 290, 330, 185, 225]
  const pick = bases[Math.abs(h) % bases.length]
  return (pick + (h % 24) - 12 + 360) % 360
}
