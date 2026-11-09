import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from '../errors.ts'
import type { Dirent } from 'node:fs'
import type { AniShareDatabase } from '../model/database.ts'
import type { AppConfig, LibraryId, LibFolder } from '../types.ts'

const DEFAULT_MAX_DEPTH = 4
const HARD_MAX_DEPTH = 10
const LISTING_LIMIT = 400
const STAT_CONCURRENCY = 32

/** 不参与扫描的目录名（大小写不敏感）；以 . 开头的名称另行过滤。 */
const IGNORED_NAMES = new Set([
  '@eadir', '#recycle', '$recycle.bin', 'system volume information', 'node_modules',
])

/** 一级子项描述，供 Agent 判断目录内容；只读取元数据，不读文件内容。 */
export interface ScanEntry {
  name: string
  kind: 'dir' | 'file' | 'link'
  ext?: string
  size?: number
  mtimeMs?: number
}

export interface ScanEntries {
  items: ScanEntry[]
  truncated: boolean
  total: number
}

/** onChanged 收到的目录上下文：只带 Agent 需要的字段。 */
export interface ScanLibraryRef {
  id: string
  name: string
}

export interface ScanFolderRef {
  id: number | null
  relPath: string
  name: string
  depth: number
}

export interface ScanFolderChange {
  library: ScanLibraryRef
  folder: ScanFolderRef
  entries: ScanEntries
}

export interface ScanOptions {
  maxDepth?: number
  signal?: AbortSignal
  onChanged?: (change: ScanFolderChange) => void | Promise<void>
}

export interface ScanSummary {
  libraryId: string
  visited: number
  changed: number
  failed: number
  missing: number
  durationMs: number
}

export interface LibFolderService {
  scan(libraryId: LibraryId, options?: ScanOptions): Promise<ScanSummary>
  list(libraryId: LibraryId, options?: { includeMissing?: boolean }): LibFolder[]
  find(libraryId: LibraryId, relPath?: string): LibFolder | null
  stats(libraryId: LibraryId): Record<string, number>
}

export interface LibFolderServiceDependencies {
  models: AniShareDatabase
  settings: AppConfig
}

/** 遍历栈中的目录节点；mtimeMs/entryCount 由磁盘 stat 与目录项填充。 */
interface ScanNode {
  abs: string
  rel: string
  name: string
  depth: number
  parentId: number | null
  mtimeMs?: number
  entryCount?: number
}

const isIgnored = (name: string): boolean => name.startsWith('.') || IGNORED_NAMES.has(name.toLowerCase())
const cancelled = (): HttpError => new HttpError(499, '扫描已取消', 'CANCELLED')
const childPath = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name)
const summarize = (error: unknown): string => String((error as { message?: unknown } | null | undefined)?.message || error || '未知错误').slice(0, 1000)

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      result[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return result
}

/** 读取目录项的元数据；只对文件 stat 大小与修改时间。 */
async function describeEntries(absDir: string, entries: Dirent[]): Promise<ScanEntries> {
  const limited = entries.slice(0, LISTING_LIMIT)
  const items = await mapLimit(limited, STAT_CONCURRENCY, async (entry): Promise<ScanEntry> => {
    const item: ScanEntry = { name: entry.name, kind: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file' }
    if (item.kind !== 'file') return item
    item.ext = path.extname(entry.name).slice(1).toLowerCase()
    const stat = await fs.stat(path.join(absDir, entry.name)).catch(() => null)
    if (stat) { item.size = stat.size; item.mtimeMs = Math.trunc(stat.mtimeMs) }
    return item
  })
  return { items, truncated: entries.length > limited.length, total: entries.length }
}

/**
 * 目录树扫描：逐层 stat，只有新增或变更的目录才交给 onChanged。
 * 注意不能用父目录 mtime 跳过子树——子目录内的改名不会更新父目录 mtime。
 */
export function createLibFolderService({ models, settings }: LibFolderServiceDependencies): LibFolderService {
  const model = models.libFolder

  const persist = (libraryId: string, node: ScanNode, row: LibFolder | null, patch: Record<string, unknown>): LibFolder => model.save({
    id: row?.id, libraryId, relPath: node.rel, name: node.name, depth: node.depth, parentId: node.parentId,
    mtimeMs: node.mtimeMs ?? 0, entryCount: node.entryCount, scannedAt: row?.scannedAt ?? null, status: 'pending', error: null,
    ...patch,
  })

  /** 目录已从磁盘消失：保留记录并递归标记，历史与观看进度不受影响。 */
  const markMissing = (row: LibFolder): number => {
    if (row.status === 'missing') return 0
    model.save({ ...row, status: 'missing', error: '目录不存在' })
    let count = 1
    for (const child of model.children(row.libraryId, row.id)) count += markMissing(child)
    return count
  }

  async function scan(libraryId: LibraryId, options: ScanOptions = {}): Promise<ScanSummary> {
    const library = settings.getLibrary(libraryId)
    const requested = options.maxDepth ?? DEFAULT_MAX_DEPTH
    if (!Number.isInteger(requested) || requested < 0 || requested > HARD_MAX_DEPTH) {
      throw new HttpError(400, `扫描深度必须是 0 至 ${HARD_MAX_DEPTH} 的整数`)
    }
    const { signal, onChanged } = options
    const startedAt = Date.now()
    const summary: ScanSummary = { libraryId: library.id, visited: 0, changed: 0, failed: 0, missing: 0, durationMs: 0 }

    const rootStat = await fs.stat(library.root).catch(() => null)
    if (!rootStat || !rootStat.isDirectory()) {
      throw new HttpError(404, `媒体库目录不可用：${library.root}`, 'LIBRARY_UNAVAILABLE')
    }

    const stack: ScanNode[] = [{ abs: library.root, rel: '', name: library.name, depth: 0, parentId: null }]
    while (stack.length) {
      if (signal?.aborted) throw cancelled()
      const node = stack.pop()
      if (!node) break
      summary.visited++

      const stat = await fs.stat(node.abs).catch(() => null)
      if (!stat || !stat.isDirectory()) {
        const missingRow: LibFolder | null = model.find(library.id, node.rel)
        if (missingRow && missingRow.status !== 'missing') {
          model.save({ ...missingRow, status: 'missing', error: '目录不存在', updatedAt: Date.now() })
        }
        summary.missing++
        continue
      }
      node.mtimeMs = Math.trunc(stat.mtimeMs)
      const row: LibFolder | null = model.find(library.id, node.rel)
      const entries = await fs.readdir(node.abs, { withFileTypes: true }).catch(() => null)
      if (!entries) {
        model.save({
          id: row?.id, libraryId: library.id, relPath: node.rel, name: node.name, depth: node.depth,
          parentId: node.parentId, mtimeMs: node.mtimeMs, entryCount: row?.entryCount ?? 0,
          status: 'failed', error: '目录无法读取', scannedAt: row?.scannedAt ?? null,
        })
        summary.failed++
        continue
      }

      const visible = entries.filter((entry) => !isIgnored(entry.name))
      node.entryCount = visible.length
      const changed = !row || row.status !== 'scanned' || row.mtimeMs !== node.mtimeMs || row.entryCount !== visible.length

      let saved: LibFolder
      if (changed && onChanged) {
        let failure: string | null = null
        try {
          const listing = await describeEntries(node.abs, visible)
          await onChanged({
            library: { id: library.id, name: library.name },
            folder: { id: row?.id ?? null, relPath: node.rel, name: node.name, depth: node.depth },
            entries: listing,
          })
        } catch (error) {
          if (signal?.aborted) throw cancelled()
          failure = summarize(error)
        }
        saved = failure
          ? persist(library.id, node, row, { status: 'failed', error: failure })
          : persist(library.id, node, row, { status: 'scanned', scannedAt: Date.now() })
        if (failure) summary.failed++
      } else {
        saved = persist(library.id, node, row, { status: 'scanned', scannedAt: Date.now() })
      }
      if (changed) summary.changed += 1

      const childDirs = visible.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      // 已记录但磁盘上不存在的子目录：标记 missing，删除不会改变父目录找不到的证据。
      const present = new Set(childDirs.map((entry) => entry.name))
      for (const child of model.children(library.id, saved.id)) {
        if (!present.has(child.name)) summary.missing += markMissing(child)
      }

      if (node.depth >= requested) continue
      for (const entry of childDirs) {
        stack.push({
          abs: path.join(node.abs, entry.name), rel: childPath(node.rel, entry.name),
          name: entry.name, depth: node.depth + 1, parentId: saved.id,
        })
      }
    }

    summary.durationMs = Date.now() - startedAt
    return summary
  }

  return {
    scan,
    /** 默认隐藏 missing：目录已从磁盘消失，连同其子树都不再展示，但记录保留。 */
    list(libraryId: LibraryId, { includeMissing = false }: { includeMissing?: boolean } = {}): LibFolder[] {
      const rows: LibFolder[] = model.list(settings.getLibrary(libraryId).id)
      if (includeMissing) return rows
      const hidden = new Set<number>()
      for (const row of rows) {
        if (row.status === 'missing' || (row.parentId !== null && hidden.has(row.parentId))) hidden.add(row.id)
      }
      return rows.filter((row) => !hidden.has(row.id))
    },
    find(libraryId: LibraryId, relPath?: string): LibFolder | null { return model.find(settings.getLibrary(libraryId).id, relPath ?? '') },
    stats(libraryId: LibraryId): Record<string, number> { return model.stats(settings.getLibrary(libraryId).id) },
  }
}
