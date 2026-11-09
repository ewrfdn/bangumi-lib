import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { AiConfig, AppConfig, CrawlerConfig, Library } from './types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const SERVER_ROOT = path.resolve(__dirname, '..')
export const PROJECT_ROOT = path.resolve(__dirname, '../..')

type Env = NodeJS.ProcessEnv

interface LibraryDefinition {
  readonly id: string
  readonly name: string
  readonly mediaType: string
  readonly env: string
  readonly legacy: readonly string[]
  readonly fallback: string | null
}

/** 极简 .env 加载（不覆盖已有环境变量） */
function loadDotEnv(): void {
  const file = process.env.ENV_FILE || path.join(SERVER_ROOT, '.env')
  if (!fs.existsSync(file)) return
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}
loadDotEnv()

function expandHome(p: string): string {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * 媒体库种类与 id 由代码固定，环境变量只提供根目录。
 * 新增一种库时在这里加一条，并让部署环境提供对应的路径变量。
 */
const LIBRARY_DEFS: readonly LibraryDefinition[] = Object.freeze([
  Object.freeze({
    id: 'bangumi', name: '番剧库', mediaType: 'anime',
    env: 'BANGUMI_LIBRARY', legacy: ['BANGUMI_ROOT', 'MEDIA_ROOT'], fallback: '~/bangumi',
  }),
  Object.freeze({
    id: 'movie', name: '电影库', mediaType: 'movie',
    env: 'MOVIE_LIBRARY', legacy: [], fallback: null,
  }),
])

/** 读取单个媒体库根目录；返回 null 表示该库未启用。 */
function libraryRoot(definition: LibraryDefinition, env: Env): string | null {
  for (const name of [definition.env, ...definition.legacy]) {
    const raw = env[name]
    if (typeof raw !== 'string' || !raw.trim()) continue
    if (raw.includes('\0')) throw new Error(`${name} 包含无效字符`)
    return path.resolve(expandHome(raw.trim()))
  }
  return definition.fallback ? path.resolve(expandHome(definition.fallback)) : null
}

export function parseLibraries(env: Env = process.env): Library[] {
  if (env.MEDIA_LIBRARIES?.trim()) {
    throw new Error('MEDIA_LIBRARIES 已废弃：番剧库请改用 BANGUMI_LIBRARY，电影库请改用 MOVIE_LIBRARY')
  }
  const libraries: Library[] = []
  for (const definition of LIBRARY_DEFS) {
    const root = libraryRoot(definition, env)
    if (!root) continue
    if (libraries.some((library) => library.root === root)) {
      throw new Error(`媒体库目录重复：${root}，每个库必须使用独立目录`)
    }
    libraries.push({ id: definition.id, name: definition.name, mediaType: definition.mediaType, root })
  }
  if (!libraries.length) throw new Error('至少需要配置一个媒体库目录，例如 BANGUMI_LIBRARY=/media/bangumi')
  return libraries
}

interface CrawlerDefaults {
  enabled: boolean
  timeoutMs: number
  maxRetries: number
  minIntervalMs: number
}

/** Source settings stay server-side and are passed to each crawler independently. */
export function parseCrawlerConfig(env: Env = process.env): CrawlerConfig {
  const sourceConfig = (prefix: string, defaults: CrawlerDefaults) => {
    const read = (name: string, fallback: string | null): string | null =>
      env[prefix + '_CRAWLER_' + name]?.trim() || fallback
    const integer = (name: string, fallback: number, min: number, max: number): number => {
      const raw = read(name, String(fallback)) ?? ''
      if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
        throw new Error(prefix + '_CRAWLER_' + name + ' 配置无效')
      }
      return Number(raw)
    }
    const enabled = read('ENABLED', defaults.enabled ? '1' : '0')
    if (enabled !== '0' && enabled !== '1') throw new Error(prefix + '_CRAWLER_ENABLED 必须为 0 或 1')
    const proxyUrl = read('PROXY_URL', null)
    if (proxyUrl) {
      let proxy: URL | undefined
      try { proxy = new URL(proxyUrl) } catch {}
      if (!proxy || !['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== '/' || proxy.hash || proxy.search) {
        throw new Error(prefix + '_CRAWLER_PROXY_URL 需要有效的 HTTP/HTTPS 代理地址')
      }
    }
    const userAgent = read('USER_AGENT', 'anishare/bangumi-lib/0.1') ?? ''
    if (!/^[\x20-\x7e]{1,500}$/.test(userAgent)) throw new Error(prefix + '_CRAWLER_USER_AGENT 配置无效')
    return {
      enabled: enabled === '1', proxyUrl, userAgent,
      token: read('TOKEN', '') ?? '',
      timeoutMs: integer('TIMEOUT_MS', defaults.timeoutMs, 100, 120000),
      operationTimeoutMs: integer('OPERATION_TIMEOUT_MS', 35000, 100, 180000),
      maxRetries: integer('MAX_RETRIES', defaults.maxRetries, 0, 3),
      minIntervalMs: integer('MIN_INTERVAL_MS', defaults.minIntervalMs, 0, 60000),
      concurrency: 1,
    }
  }
  return {
    bangumi: sourceConfig('BANGUMI', { enabled: true, timeoutMs: 15000, maxRetries: 1, minIntervalMs: 1000 }),
    douban: sourceConfig('DOUBAN', { enabled: false, timeoutMs: 20000, maxRetries: 0, minIntervalMs: 2000 }),
  }
}

const mediaLibraries = parseLibraries(process.env)
for (const library of mediaLibraries) {
  if (!fs.existsSync(library.root)) console.warn(`[config] 媒体库“${library.name}”目录不存在：${library.root}`)
}
const dataDir = path.resolve(PROJECT_ROOT, expandHome(process.env.DATA_DIR || 'data'))

export const config: AppConfig = {
  get mediaRoot(): string {
    return mediaLibraries[0].root
  },
  get libraries(): Library[] {
    return mediaLibraries
  },
  get defaultLibraryId(): string {
    return mediaLibraries[0].id
  },
  getLibrary(id: string = mediaLibraries[0].id): Library {
    const library = mediaLibraries.find((entry) => entry.id === id)
    if (!library) {
      const error = new Error('媒体库不存在') as Error & { status: number }
      error.status = 404
      throw error
    }
    return library
  },
  setMediaRoot(next: string): void {
    const abs = path.resolve(expandHome(next))
    mediaLibraries[0] = { ...mediaLibraries[0], root: abs }
    process.env.BANGUMI_ROOT = abs
  },
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 8088),
  authSecret: process.env.AUTH_SECRET || '',
  sessionDays: Math.max(1, Math.min(365, Number(process.env.SESSION_DAYS) || 30)),
  secureCookies: process.env.COOKIE_SECURE === '1',
  frontendOrigins: (process.env.FRONTEND_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
  crawlers: parseCrawlerConfig(),
  aiConfigKey: process.env.AI_CONFIG_KEY || '',
  aiDefaults: {
    enabled: process.env.AI_ENABLED === '1',
    apiFormat: process.env.AI_API_FORMAT || 'openai-completions',
    baseUrl: process.env.AI_BASE_URL || '',
    model: process.env.AI_MODEL || '',
    apiKey: process.env.AI_API_KEY || '',
    maxTokens: Number(process.env.AI_MAX_TOKENS) || 2048,
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 30000,
  } satisfies AiConfig,
  dbPath: process.env.DB_PATH === ':memory:' ? ':memory:' : path.resolve(PROJECT_ROOT, expandHome(process.env.DB_PATH || path.join(dataDir, 'anishare.sqlite'))),
  tasksConfigPath: process.env.TASKS_CONFIG
    ? path.resolve(PROJECT_ROOT, expandHome(process.env.TASKS_CONFIG))
    : path.join(SERVER_ROOT, 'config', 'tasks.yaml'),
  ffmpeg: {
    ffmpegPath: process.env.FFMPEG_PATH || '',
    ffprobePath: process.env.FFPROBE_PATH || '',
    videoCodec: process.env.TRANSCODE_VIDEO_CODEC || '',
    preset: process.env.TRANSCODE_VIDEO_PRESET || '',
    bitrate: process.env.TRANSCODE_VIDEO_BITRATE || '',
    hwaccel: process.env.TRANSCODE_HWACCEL || '',
    maxBitrate: process.env.TRANSCODE_MAX_BITRATE || '',
    audioBitrate: process.env.TRANSCODE_AUDIO_BITRATE || '192k',
    tonemap: process.env.TRANSCODE_TONEMAP !== '0',
    // 软件编码线程数（内存受限环境调小，默认 0 = 自动）
    threads: Number(process.env.TRANSCODE_THREADS || 0),
    // 编码器 lookahead，越小内存越省
    rcLookahead: Number(process.env.TRANSCODE_RC_LOOKAHEAD || 0),
  },
  dataDir,
}
