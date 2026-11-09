import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Database as DatabaseHandle } from 'better-sqlite3'
import { createCatalogModels } from './catalog.model.ts'
import { createLibFolderModel } from './lib-folder.model.ts'
import type { AppSettingsRow, PlaybackProgress } from '../types.ts'

const PROGRESS_TABLE = `
  CREATE TABLE playback_progress (
    library_id TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    time REAL NOT NULL CHECK (time >= 0),
    duration REAL NOT NULL CHECK (duration > 0),
    at INTEGER NOT NULL,
    hevc INTEGER NOT NULL DEFAULT 0,
    poster TEXT,
    series_path TEXT,
    series_title TEXT,
    PRIMARY KEY (library_id, path)
  )
`
const PROGRESS_COLUMNS = `library_id AS libraryId, path, title, time, duration, at, hevc, poster,
  series_path AS seriesPath, series_title AS seriesTitle`

export type ProgressInput = Omit<PlaybackProgress, 'hevc'> & { hevc?: boolean | number | null }
export type ProgressRow = Omit<PlaybackProgress, 'hevc'> & { hevc: number | boolean }

export interface SessionRow { expires_at: number }

export interface DatabaseInfo {
  type: 'sqlite'
  path: string
  schemaVersion: number
  progressCount: number
}

export interface AniShareDatabase {
  filename: string
  catalog: ReturnType<typeof createCatalogModels>
  libFolder: ReturnType<typeof createLibFolderModel>
  listProgress(libraryId?: string): PlaybackProgress[]
  getProgress(itemPath: string, libraryId?: string): PlaybackProgress | null
  writeProgress(item: ProgressInput): PlaybackProgress | null
  importProgress(items: ProgressInput[]): void
  deleteProgress(itemPath: string, libraryId?: string): Database.RunResult
  findSession(tokenHash: string, secretHash: string, now: number): SessionRow | undefined
  createSession(tokenHash: string, secretHash: string, expiresAt: number): Database.RunResult
  deleteSession(tokenHash: string): Database.RunResult
  cleanSessions(now: number, secretHash: string): Database.RunResult
  getSetting(name: string): AppSettingsRow | null
  setSetting(name: string, value: string, updatedAt?: number): Database.RunResult
  info(): DatabaseInfo
  close(): void
}

/** Connection and versioned migrations; legacy history remains available. */
export function createDatabase(filename: string, defaultLibraryId = 'bangumi'): AniShareDatabase {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true })
  const db: DatabaseHandle = new Database(filename)
  const version = db.pragma('user_version', { simple: true }) as number
  if (version > 6) { db.close(); throw new Error('数据库版本高于当前程序支持的版本') }
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  try {
    // Move v1 path-only records into the configured default library atomically.
    if (version < 3) db.transaction(() => {
      if ((db.pragma('user_version', { simple: true }) as number) >= 3) return
      const columns = db.pragma('table_info(playback_progress)') as Array<{ name: string }>
      if (!columns.length) {
        db.exec(PROGRESS_TABLE)
      } else if (!columns.some((column) => column.name === 'library_id')) {
        db.exec('ALTER TABLE playback_progress RENAME TO playback_progress_v1')
        db.exec(PROGRESS_TABLE)
        db.prepare(`INSERT INTO playback_progress (library_id, path, title, time, duration, at, hevc, poster)
          SELECT ?, path, title, time, duration, at, hevc, poster FROM playback_progress_v1`).run(defaultLibraryId)
        db.exec('DROP TABLE playback_progress_v1')
      } else {
        if (!columns.some((column) => column.name === 'series_path')) db.exec('ALTER TABLE playback_progress ADD COLUMN series_path TEXT')
        if (!columns.some((column) => column.name === 'series_title')) db.exec('ALTER TABLE playback_progress ADD COLUMN series_title TEXT')
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS playback_progress_recent ON playback_progress(at DESC);
        CREATE INDEX IF NOT EXISTS playback_progress_library_recent ON playback_progress(library_id, at DESC);
        CREATE TABLE IF NOT EXISTS auth_sessions (
          token_hash TEXT PRIMARY KEY,
          secret_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
        CREATE TABLE IF NOT EXISTS app_settings (
          name TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 3;
      `)
    }).immediate()
    if (version < 4) db.transaction(() => {
      if ((db.pragma('user_version', { simple: true }) as number) >= 4) return
      db.exec(fs.readFileSync(new URL('../../db/migrations/004_catalog.sql', import.meta.url), 'utf8'))
      db.pragma('user_version = 4')
    }).immediate()
    if (version < 5) db.transaction(() => {
      if ((db.pragma('user_version', { simple: true }) as number) >= 5) return
      db.exec(fs.readFileSync(new URL('../../db/migrations/005_media_source.sql', import.meta.url), 'utf8'))
      db.pragma('user_version = 5')
    }).immediate()
    if (version < 6) db.transaction(() => {
      if ((db.pragma('user_version', { simple: true }) as number) >= 6) return
      db.exec(fs.readFileSync(new URL('../../db/migrations/006_lib_folder.sql', import.meta.url), 'utf8'))
      db.pragma('user_version = 6')
    }).immediate()
  } catch (error) { db.close(); throw error }
  const progressList = db.prepare(`SELECT ${PROGRESS_COLUMNS} FROM playback_progress ORDER BY at DESC LIMIT 500`)
  const progressLibraryList = db.prepare(`SELECT ${PROGRESS_COLUMNS} FROM playback_progress WHERE library_id = ? ORDER BY at DESC LIMIT 500`)
  const progressGet = db.prepare(`SELECT ${PROGRESS_COLUMNS} FROM playback_progress WHERE library_id = ? AND path = ?`)
  const progressDelete = db.prepare('DELETE FROM playback_progress WHERE library_id = ? AND path = ?')
  const progressUpsert = db.prepare(`
    INSERT INTO playback_progress (library_id, path, title, time, duration, at, hevc, poster, series_path, series_title)
    VALUES (@libraryId, @path, @title, @time, @duration, @at, @hevc, @poster, @seriesPath, @seriesTitle)
    ON CONFLICT(library_id, path) DO UPDATE SET
      title = excluded.title, time = excluded.time, duration = excluded.duration,
      at = excluded.at, hevc = excluded.hevc, poster = excluded.poster,
      series_path = excluded.series_path, series_title = excluded.series_title
    WHERE excluded.at >= playback_progress.at
  `)
  const sessionGet = db.prepare('SELECT expires_at FROM auth_sessions WHERE token_hash = ? AND secret_hash = ? AND expires_at > ?')
  const sessionPut = db.prepare('INSERT INTO auth_sessions (token_hash, secret_hash, expires_at) VALUES (?, ?, ?)')
  const sessionDelete = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
  const sessionClean = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR secret_hash != ?')
  const settingGet = db.prepare('SELECT value, updated_at AS updatedAt FROM app_settings WHERE name = ?')
  const settingPut = db.prepare(`INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)

  const rowToItem = (row: unknown): PlaybackProgress | null =>
    row ? { ...(row as ProgressRow), hevc: Boolean((row as ProgressRow).hevc) } : null

  const writeProgress = (item: ProgressInput): PlaybackProgress | null => {
    const record = { ...item, libraryId: item.libraryId ?? defaultLibraryId }
    progressUpsert.run({ ...record, hevc: record.hevc ? 1 : 0,
      poster: record.poster || null, seriesPath: record.seriesPath || null, seriesTitle: record.seriesTitle || null })
    return rowToItem(progressGet.get(record.libraryId, record.path))
  }
  const importProgress = db.transaction((items: ProgressInput[]) => {
    for (const item of items) writeProgress(item)
  })
  return {
    filename,
    catalog: createCatalogModels(db),
    libFolder: createLibFolderModel(db),
    listProgress: (libraryId?: string) => (libraryId === undefined
      ? progressList.all()
      : progressLibraryList.all(libraryId)).map(rowToItem).filter((row): row is PlaybackProgress => row !== null),
    getProgress: (itemPath: string, libraryId = defaultLibraryId) => rowToItem(progressGet.get(libraryId, itemPath)),
    writeProgress,
    importProgress,
    deleteProgress: (itemPath: string, libraryId = defaultLibraryId) => progressDelete.run(libraryId, itemPath),
    findSession: (tokenHash: string, secretHash: string, now: number) => sessionGet.get(tokenHash, secretHash, now) as SessionRow | undefined,
    createSession: (tokenHash: string, secretHash: string, expiresAt: number) => sessionPut.run(tokenHash, secretHash, expiresAt),
    deleteSession: (tokenHash: string) => sessionDelete.run(tokenHash),
    cleanSessions: (now: number, secretHash: string) => sessionClean.run(now, secretHash),
    getSetting: (name: string) => (settingGet.get(name) as AppSettingsRow | undefined) || null,
    setSetting: (name: string, value: string, updatedAt = Date.now()) => settingPut.run(name, value, updatedAt),
    info: () => ({
      type: 'sqlite' as const,
      path: filename,
      schemaVersion: db.pragma('user_version', { simple: true }) as number,
      progressCount: (db.prepare('SELECT COUNT(*) AS count FROM playback_progress').get() as { count: number }).count,
    }),
    close: () => { if (db.open) db.close() },
  }
}
