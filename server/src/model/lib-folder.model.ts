import type { Database as DatabaseHandle } from 'better-sqlite3'
import type { LibFolder, LibFolderStatus } from '../types.ts'

/** Row shape produced by the SELECT aliases below; status is TEXT in SQLite. */
interface LibFolderRow {
  id: number
  parentId: number | null
  libraryId: string
  relPath: string
  name: string
  depth: number
  mtimeMs: number
  entryCount: number
  scannedAt: number | null
  status: string
  error: string | null
  createdAt: number
  updatedAt: number
}

interface StatusCountRow {
  status: string
  count: number
}

/**
 * Upsert payload. Identity (libraryId, relPath) plus the fields the caller drives are required;
 * the rest (and the timestamps, which SQL owns) may be omitted.
 */
export type LibFolderInput = Pick<LibFolder, 'libraryId' | 'relPath' | 'name' | 'depth' | 'mtimeMs'>
  & Partial<Omit<LibFolder, 'libraryId' | 'relPath' | 'name' | 'depth' | 'mtimeMs'>>

export interface LibFolderModel {
  find(libraryId: string, relPath: string): LibFolder | null
  get(id: number): LibFolder | null
  children(libraryId: string, parentId: number | null): LibFolder[]
  roots(libraryId: string): LibFolder[]
  list(libraryId: string): LibFolder[]
  save(node: LibFolderInput): LibFolder
  stats(libraryId: string): Record<string, number>
}

function toLibFolder(row: unknown): LibFolder | null {
  if (!row || typeof row !== 'object') return null
  const record = row as LibFolderRow
  return {
    id: record.id,
    parentId: record.parentId,
    libraryId: record.libraryId,
    relPath: record.relPath,
    name: record.name,
    depth: record.depth,
    mtimeMs: record.mtimeMs,
    entryCount: record.entryCount,
    scannedAt: record.scannedAt,
    // status 由建表约束限定为 LibFolderStatus，SQLite 只保存 TEXT。
    status: record.status as LibFolderStatus,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * lib_folder SQL only. Traversal, change detection and agent policy belong to the service.
 * A folder's identity is (library_id, rel_path); parent_id mirrors the on-disk tree.
 */
export function createLibFolderModel(db: DatabaseHandle): LibFolderModel {
  const columns = `id, parent_id AS parentId, library_id AS libraryId, rel_path AS relPath, name, depth,
    mtime_ms AS mtimeMs, entry_count AS entryCount, scanned_at AS scannedAt, status, error,
    created_at AS createdAt, updated_at AS updatedAt`
  const byId = db.prepare(`SELECT ${columns} FROM lib_folder WHERE id = ?`)
  const byPath = db.prepare(`SELECT ${columns} FROM lib_folder WHERE library_id = ? AND rel_path = ?`)
  const childRows = db.prepare(`SELECT ${columns} FROM lib_folder WHERE library_id = ? AND parent_id = ? ORDER BY name`)
  const rootRows = db.prepare(`SELECT ${columns} FROM lib_folder WHERE library_id = ? AND parent_id IS NULL ORDER BY id`)
  const all = db.prepare(`SELECT ${columns} FROM lib_folder WHERE library_id = ? ORDER BY rel_path`)
  const insert = db.prepare(`INSERT INTO lib_folder
    (parent_id, library_id, rel_path, name, depth, mtime_ms, entry_count, scanned_at, status, error, created_at, updated_at)
    VALUES (@parentId, @libraryId, @relPath, @name, @depth, @mtimeMs, @entryCount, @scannedAt, @status, @error, @now, @now)`)
  const update = db.prepare(`UPDATE lib_folder SET
    parent_id = @parentId, name = @name, depth = @depth, mtime_ms = @mtimeMs, entry_count = @entryCount,
    scanned_at = @scannedAt, status = @status, error = @error, updated_at = @now
    WHERE id = @id`)

  const save = db.transaction((node: LibFolderInput): LibFolder => {
    const now = Date.now()
    const existing = node.id ? toLibFolder(byId.get(node.id)) : toLibFolder(byPath.get(node.libraryId, node.relPath))
    const record = {
      parentId: node.parentId ?? null, libraryId: node.libraryId, relPath: node.relPath, name: node.name,
      depth: node.depth, mtimeMs: node.mtimeMs, entryCount: node.entryCount ?? 0,
      scannedAt: node.scannedAt ?? null, status: node.status ?? 'pending', error: node.error ?? null, now,
    }
    if (existing) {
      update.run({ ...record, id: existing.id })
      // The update runs in this immediate transaction, so the row is still there.
      return byId.get(existing.id) as LibFolder
    }
    return byId.get(Number(insert.run(record).lastInsertRowid)) as LibFolder
  }).immediate

  return {
    find(libraryId: string, relPath: string): LibFolder | null {
      return toLibFolder(byPath.get(libraryId, relPath))
    },
    get(id: number): LibFolder | null {
      return toLibFolder(byId.get(id))
    },
    children(libraryId: string, parentId: number | null): LibFolder[] {
      return childRows.all(libraryId, parentId ?? null)
        .map(toLibFolder)
        .filter((folder): folder is LibFolder => folder !== null)
    },
    roots(libraryId: string): LibFolder[] {
      return rootRows.all(libraryId)
        .map(toLibFolder)
        .filter((folder): folder is LibFolder => folder !== null)
    },
    list(libraryId: string): LibFolder[] {
      return all.all(libraryId)
        .map(toLibFolder)
        .filter((folder): folder is LibFolder => folder !== null)
    },
    save,
    stats(libraryId: string): Record<string, number> {
      const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM lib_folder WHERE library_id = ? GROUP BY status`)
        .all(libraryId) as StatusCountRow[]
      return rows.reduce<Record<string, number>>((result, row) => ({ ...result, [row.status]: row.count }), {})
    },
  }
}
