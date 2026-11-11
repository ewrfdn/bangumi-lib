async function getJSON(url, options = {}) {
  const { body, ...rest } = options
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...rest,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text.slice(0, 200) }
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event('anishare:unauthorized'))
    }
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
  authSession: () => getJSON('/api/auth/session'),
  login: (key) => getJSON('/api/auth/login', { method: 'POST', body: { key } }),
  logout: () => getJSON('/api/auth/logout', { method: 'POST', body: {} }),
  progress: (library) => getJSON(`/api/progress?${q({ library })}`),
  saveProgress: (item, { keepalive = false } = {}) => getJSON('/api/progress', { method: 'PUT', body: item, keepalive }),
  importProgress: (items) => getJSON('/api/progress/import', { method: 'POST', body: { items } }),
  deleteProgress: (path, library) => getJSON(`/api/progress?${q({ path, library })}`, { method: 'DELETE' }),
  status: () => getJSON('/api/status'),
  aiConfig: () => getJSON('/api/admin/ai/config'),
  saveAiConfig: (config) => getJSON('/api/admin/ai/config', { method: 'PUT', body: config }),
  testAiConfig: (config) => getJSON('/api/admin/ai/test', { method: 'POST', body: config }),
  searchConfig: () => getJSON('/api/admin/ai/search'),
  saveSearchConfig: (config) => getJSON('/api/admin/ai/search', { method: 'PUT', body: config }),
  testSearchConfig: (config) => getJSON('/api/admin/ai/search/test', { method: 'POST', body: config }),
  tasks: (params = {}) => getJSON(`/api/tasks?${q(params)}`),
  cancelTask: (id) => getJSON(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  deleteTask: (id) => getJSON(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  schedulerTasks: () => getJSON('/api/scheduler/tasks'),
  runSchedulerTask: (type) => getJSON(`/api/scheduler/tasks/${encodeURIComponent(type)}/run`, { method: 'POST' }),
  reloadScheduler: () => getJSON('/api/scheduler/reload', { method: 'POST' }),
  runAgent: (prompt) => getJSON('/api/agent/run', { method: 'POST', body: { prompt } }),
  media: (params = {}) => getJSON(`/api/media?${q(params)}`),
  libraries: () => getJSON('/api/libraries'),
  library: (library) => getJSON(`/api/library?${q({ library })}`),
  series: (path, library) => getJSON(`/api/library/series?${q({ path, library })}`),
  list: (path, library) => getJSON(`/api/list?${q({ path, library })}`),
  video: (path, library) => getJSON(`/api/video?${q({ path, library })}`),

  streamUrl: (path, library) => `/api/stream?${q({ path, library })}`,
  fileUrl: (path, library) => `/api/file?${q({ path, library })}`,
  subtitleUrl: (path, library) => `/api/subtitle?${q({ path, library })}`,
  streamSubtitleUrl: (path, index, library) => `/api/stream-subtitle?${q({ path, index, library })}`,
  hlsStart: (path, t = 0, library) => getJSON(`/api/hls/start?${q({ path, library, t: Math.max(0, Math.floor(t)) })}`),
  hlsStop: (id) => fetch(`/api/hls/${id}`, { method: 'DELETE' }).catch(() => {}),
  hlsInfo: (id) => getJSON(`/api/hls/${id}/info`),
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

export const MEDIA_TYPE_LABELS = { anime: '番剧', movie: '电影' }
export const mediaTypeLabel = (type) => MEDIA_TYPE_LABELS[type] || type || ''
export const mediaSourceLabel = (source) =>
  ({ bangumi: 'Bangumi', douban: '豆瓣' })[String(source || '').toLowerCase()] || source || ''

/** 数据库封面：外部 URL、Bangumi 资源、扫描生成的本地封面或媒体库内相对路径。 */
export function mediaCoverUrl(cover, library = '') {
  if (!cover) return ''
  if (/^https?:\/\//i.test(cover)) return cover
  if (cover.startsWith('/')) return cover
  const parts = cover.split('/').filter(Boolean).map((part) => encodeURIComponent(part))
  if (cover.startsWith('bangumi/') || cover.startsWith('local-media/')) return `/assets/${parts.join('/')}`
  return api.fileUrl(cover, library)
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
