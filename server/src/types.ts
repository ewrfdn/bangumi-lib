/** Shared domain shapes. SQL columns are snake_case; every model row is camelCase. */

export type LibraryId = 'bangumi' | 'movie' | string

export interface Library {
  id: LibraryId
  name: string
  mediaType: string
  root: string
}

export interface AiConfig {
  enabled: boolean
  apiFormat: string
  baseUrl: string
  model: string
  apiKey: string
  maxTokens: number
  timeoutMs: number
}

/** DeepSeek Search / Fetch API 的联网搜索配置（密钥单独加密存放）。 */
export interface SearchConfig {
  enabled: boolean
  baseUrl: string
  /** 单次搜索返回条数，1–50。 */
  count: number
  /** 是否让搜索接口返回网页 content。 */
  needContent: boolean
  timeoutMs: number
  /** 复用「模型服务」里保存的 API Key（主模型同样是 DeepSeek 时）。 */
  reuseModelKey: boolean
}

export interface CrawlerSourceConfig {
  enabled: boolean
  proxyUrl: string | null
  userAgent: string
  token: string
  timeoutMs: number
  operationTimeoutMs: number
  maxRetries: number
  minIntervalMs: number
  concurrency: number
}

export interface CrawlerConfig {
  bangumi: CrawlerSourceConfig
  douban: CrawlerSourceConfig
}

export interface FfmpegConfig {
  ffmpegPath: string
  ffprobePath: string
  videoCodec: string
  preset: string
  bitrate: string
  hwaccel: string
  maxBitrate: string
  audioBitrate: string
  tonemap: boolean
  threads: number
  rcLookahead: number
}

export interface AppConfig {
  readonly mediaRoot: string
  readonly libraries: Library[]
  readonly defaultLibraryId: LibraryId
  getLibrary(id?: LibraryId): Library
  setMediaRoot(next: string): void
  host: string
  port: number
  authSecret: string
  sessionDays: number
  secureCookies: boolean
  frontendOrigins: string[]
  crawlers: CrawlerConfig
  aiConfigKey: string
  aiDefaults: AiConfig
  /** 联网搜索的环境变量兜底密钥（DeepSeek API Key）。 */
  deepseekSearchKey: string
  searchDefaults: SearchConfig
  dbPath: string
  tasksConfigPath: string
  ffmpeg: FfmpegConfig
  dataDir: string
}

export interface Media {
  id: number
  title: string
  cover: string | null
  mediaType: string
  season: number | null
  episodeCount: number | null
  description: string | null
  rating: number | null
  tags: string[]
  attribute: Record<string, unknown>
  airedOn: string | null
  series: string | null
  dataSource: string | null
  dataSourceUrl: string | null
  createdAt: number
  updatedAt: number
}

export interface LocalMedia {
  id: number
  libraryId: string
  folderName: string
  folderPath: string
  folderHash: string
  mediaId: number
  createdAt: number
  updatedAt: number
}

export interface LocalMediaVideo {
  id: number
  title: string
  coverPath: string | null
  mediaId: number
  videoIndex: number
  mediaPath: string
  localMediaId: number
  videoType: string
  durationMs: number | null
  width: number | null
  height: number | null
  frameCount: number | null
  sizeBytes: number | null
  mtimeMs: number | null
  missing: boolean
  createdAt: number
  updatedAt: number
}

export interface MediaTrack {
  mediaId: number
  videoIndex: number
  positionMs: number
  durationMs: number | null
  completed: boolean
  watchedAt: number
  createdAt: number
  updatedAt: number
}

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface TaskRecord {
  id: number
  type: string
  status: TaskStatus
  progress: number
  payload: Record<string, unknown> | null
  result: unknown
  error: string | null
  runAfter: number
  startedAt: number | null
  finishedAt: number | null
  createdAt: number
  updatedAt: number
}

export type LibFolderStatus = 'pending' | 'scanned' | 'failed' | 'missing'

export interface LibFolder {
  id: number
  parentId: number | null
  libraryId: string
  relPath: string
  name: string
  depth: number
  mtimeMs: number
  entryCount: number
  scannedAt: number | null
  status: LibFolderStatus
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface ListQuery {
  limit: number
  offset: number
  filters?: Record<string, unknown>
  q?: string
}

export interface ListResult<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

/** The dynamic table wrapper from catalog.model.ts. */
export interface Model<T> {
  find(key: Record<string, unknown>): T | null
  findWhere(condition: string, values?: unknown[]): T | null
  list(query: ListQuery): ListResult<T>
  create(data: Record<string, unknown>): T
  update(key: Record<string, unknown>, data: Record<string, unknown>): T | null
  remove(key: Record<string, unknown>): boolean
}

export interface Logger {
  info(obj: unknown, message?: string): void
  warn(obj: unknown, message?: string): void
  error(obj: unknown, message?: string): void
}

export interface PlaybackProgress {
  libraryId: string
  path: string
  title: string
  time: number
  duration: number
  at: number
  hevc: boolean
  poster: string | null
  seriesPath: string | null
  seriesTitle: string | null
}

export interface AppSettingsRow {
  value: string
  updatedAt: number
}
