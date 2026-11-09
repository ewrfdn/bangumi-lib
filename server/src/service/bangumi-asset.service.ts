import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from '../errors.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { CatalogService } from './catalog.service.ts'
import type { AppConfig, Logger, Media } from '../types.ts'

const SOURCE = 'bangumi'
const DEFAULT_COVER = '.jpg'
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])

/** Subject draft returned by the crawler; extra fields are copied into the catalog row as-is. */
interface SubjectDraft {
  cover?: string | null
  attribute?: Record<string, unknown>
  [key: string]: unknown
}

/** Minimal crawler surface used here; `contracts.ts` validates the fetched payload later. */
interface AssetCrawler {
  fetch(params: { sourceId: string }, options?: { signal?: AbortSignal }): Promise<unknown>
  requestImage(url: string, options?: { signal?: AbortSignal }): Promise<Buffer | null | undefined>
}

interface AssetRegistry {
  get(source: string): AssetCrawler
}

export interface ImportedSubject {
  media: Media
  created: boolean
  coverPath: string | null
  jsonPath: string
}

export interface BangumiAssetService {
  importSubject(sourceId: unknown, options?: { signal?: AbortSignal }): Promise<ImportedSubject>
  paths(sourceId: unknown): { jsonPath: string; directory: string }
}

export interface BangumiAssetServiceOptions {
  registry: AssetRegistry
  catalogService: Pick<CatalogService, 'create' | 'update'>
  models: Pick<CatalogModels, 'media'>
  settings: Pick<AppConfig, 'dataDir'>
  logger?: Logger
}

const coverExtension = (url: string): string => {
  let pathname: string
  try { pathname = new URL(url).pathname } catch { return DEFAULT_COVER }
  const match = /\.([a-z0-9]+)$/i.exec(pathname)
  const extension = match?.[1]?.toLowerCase()
  if (!extension || !IMAGE_EXTENSIONS.has(extension)) return DEFAULT_COVER
  return extension === 'jpeg' ? '.jpg' : `.${extension}`
}

async function writeAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(temporary, data)
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Bangumi 条目落盘：抓取 → 下载封面 → 写 subject.json → 按来源身份幂等写 media。
 * 文件在 data/bangumi/<sourceId>/，media.cover 保存相对路径，由 /assets 提供。
 */
export function createBangumiAssetService({ registry, catalogService, models, settings, logger }: BangumiAssetServiceOptions): BangumiAssetService {
  const assetRoot = (): string => path.join(settings.dataDir, 'bangumi')
  const inFlight = new Map<string, Promise<ImportedSubject>>()

  async function downloadCover(crawler: AssetCrawler, url: string, directory: string, signal: AbortSignal | undefined): Promise<string> {
    const buffer = await crawler.requestImage(url, { signal })
    if (!buffer?.length) throw new HttpError(502, '封面下载为空', 'COVER_EMPTY')
    const file = `cover${coverExtension(url)}`
    const target = path.join(directory, file)
    const existing = await fs.stat(target).catch(() => null)
    if (!existing || existing.size !== buffer.length) await writeAtomic(target, buffer)
    // 扩展名变化时清掉旧的 cover.*，避免同一目录堆积多余文件。
    for (const name of await fs.readdir(directory)) {
      if (name !== file && /^cover\.[a-z0-9]+$/i.test(name)) await fs.rm(path.join(directory, name), { force: true })
    }
    return file
  }

  async function importSubject(sourceId: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<ImportedSubject> {
    const id = String(sourceId ?? '').trim()
    if (!/^[1-9]\d{0,14}$/.test(id)) throw new HttpError(400, 'Bangumi 条目 ID 无效', 'INVALID_SOURCE_ID')
    const running = inFlight.get(id)
    if (running) return running

    const task = (async (): Promise<ImportedSubject> => {
      const crawler = registry.get(SOURCE)
      // The crawler contract owns the payload validation; this service only reads validated fields.
      const draft = (await crawler.fetch({ sourceId: id }, { signal })) as SubjectDraft

      const directory = path.join(assetRoot(), id)
      await fs.mkdir(directory, { recursive: true })

      const coverPath = draft.cover ? `bangumi/${id}/${await downloadCover(crawler, draft.cover, directory, signal)}` : null
      const jsonPath = `bangumi/${id}/subject.json`
      await writeAtomic(path.join(directory, 'subject.json'), JSON.stringify({
        source: SOURCE, sourceId: id, fetchedAt: Date.now(),
        subject: { ...draft, cover: coverPath ?? draft.cover ?? null },
      }, null, 2))

      const fields: Record<string, unknown> = { ...draft, ...(coverPath ? { cover: coverPath } : {}) }
      const existing = models.media.findBySource(SOURCE, id)
      if (existing) fields.attribute = { ...existing.attribute, ...draft.attribute }
      // update() keeps its model contract (`T | null`); a missing row still fails on property access.
      const media = (existing ? catalogService.update(existing.id, fields) : catalogService.create(fields)) as Media

      logger?.info?.({ sourceId: id, mediaId: media.id, created: !existing }, 'Bangumi 条目已落盘')
      return { media, created: !existing, coverPath, jsonPath }
    })().finally(() => inFlight.delete(id))

    inFlight.set(id, task)
    return task
  }

  return {
    importSubject,
    /** 只读的本地缓存路径，供工具返回给调用方。 */
    paths(sourceId: unknown): { jsonPath: string; directory: string } {
      const id = String(sourceId ?? '').trim()
      return { jsonPath: `bangumi/${id}/subject.json`, directory: path.join(assetRoot(), id) }
    },
  }
}
