import type { Database as DatabaseHandle } from 'better-sqlite3'
import type {
  ListQuery, ListResult, LocalMedia, LocalMediaVideo, Media, MediaTrack, Model, TaskRecord,
} from '../types.ts'

export interface RecordsOptions {
  keys?: string[]
  json?: string[]
  booleans?: string[]
  order?: string
  search?: string[]
}

type Row = Record<string, unknown>

/** Identifiers below are code-owned; every request value is a bound parameter. */
function records<T>(db: DatabaseHandle, table: string, fields: Record<string, string>, options: RecordsOptions = {}): Model<T> {
  const { keys = ['id'], json = [], booleans = [], order = 'id DESC', search = [] } = options
  const select = Object.entries(fields).map(([key, column]) => `${column} AS ${key}`).join(', ')
  const whereKey = keys.map(key => `${fields[key]} = ?`).join(' AND ')
  const keyValues = (key: Record<string, unknown>) => keys.map(name => key[name])
  const encode = (key: string, value: unknown): unknown =>
    json.includes(key) && value !== null ? JSON.stringify(value) : booleans.includes(key) ? Number(value) : value
  const decode = (row: unknown): T | null => {
    if (!row) return null
    const record = row as Row
    for (const key of json) if (record[key] !== null) record[key] = JSON.parse(record[key] as string)
    for (const key of booleans) record[key] = Boolean(record[key])
    return record as T
  }
  const findStatement = db.prepare(`SELECT ${select} FROM ${table} WHERE ${whereKey}`)
  const find = (key: Record<string, unknown>): T | null => decode(findStatement.get(...keyValues(key)))
  return {
    find,
    /** Single-row lookup by an explicit condition; callers pass bound parameters only. */
    findWhere(condition: string, values: unknown[] = []): T | null {
      return decode(db.prepare(`SELECT ${select} FROM ${table} WHERE ${condition} LIMIT 1`).get(...values))
    },
    list({ limit, offset, filters = {}, q = '' }: ListQuery): ListResult<T> {
      const conditions: string[] = [], values: unknown[] = []
      for (const [key, value] of Object.entries(filters)) {
        if (!Object.hasOwn(fields, key)) throw new Error('Unsupported model filter')
        conditions.push(`${fields[key]} = ?`)
        values.push(encode(key, value))
      }
      if (q && search.length) {
        conditions.push(`(${search.map(key => `instr(${fields[key]}, ?) > 0`).join(' OR ')})`)
        values.push(...search.map(() => q))
      }
      const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
      const total = (db.prepare(`SELECT COUNT(*) AS total FROM ${table}${where}`).get(...values) as { total: number }).total
      const items = db.prepare(`SELECT ${select} FROM ${table}${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...values, limit, offset).map(decode).filter((item): item is T => item !== null)
      return { items, total, limit, offset }
    },
    create(data: Record<string, unknown>): T {
      const record: Row = { ...data, createdAt: Date.now(), updatedAt: Date.now() }
      const names = Object.keys(record)
      const result = db.prepare(`INSERT INTO ${table} (${names.map(key => fields[key]).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
        .run(...names.map(key => encode(key, record[key])))
      const created = find(keys.length === 1 && keys[0] === 'id' ? { id: Number(result.lastInsertRowid) } : record)
      if (!created) throw new Error('记录创建失败')
      return created
    },
    update(key: Record<string, unknown>, data: Record<string, unknown>): T | null {
      const record: Row = { ...data, updatedAt: Date.now() }
      const names = Object.keys(record)
      db.prepare(`UPDATE ${table} SET ${names.map(name => `${fields[name]} = ?`).join(', ')} WHERE ${whereKey}`)
        .run(...names.map(name => encode(name, record[name])), ...keyValues(key))
      return find(key)
    },
    remove(key: Record<string, unknown>): boolean {
      return db.prepare(`DELETE FROM ${table} WHERE ${whereKey}`).run(...keyValues(key)).changes > 0
    },
  }
}

export type TaskModel = Model<TaskRecord> & {
  transition(current: TaskRecord, changes: Partial<TaskRecord>): TaskRecord | null
  claimNext(now: number): TaskRecord | null
}

export type MediaModel = Model<Media> & {
  findBySource(source: string, sourceId: string | number): Media | null
}

export type TracksModel = Model<MediaTrack> & {
  save(data: Pick<MediaTrack, 'mediaId' | 'videoIndex'> & Partial<MediaTrack>): MediaTrack | null
}

export interface CatalogModels {
  media: MediaModel
  localMedia: Model<LocalMedia>
  videos: Model<LocalMediaVideo>
  tracks: TracksModel
  task: TaskModel
  transaction<T>(operation: () => T): T
}

export function createCatalogModels(db: DatabaseHandle): CatalogModels {
  const timestamps = { createdAt: 'created_at', updatedAt: 'updated_at' }
  const media = records<Media>(db, 'media', {
    id: 'id', title: 'title', cover: 'cover', mediaType: 'media_type', season: 'season', episodeCount: 'episode_count',
    description: 'description', rating: 'rating', tags: 'tags', attribute: 'attribute', airedOn: 'aired_on', series: 'series',
    dataSource: 'data_source', dataSourceUrl: 'data_source_url', ...timestamps,
  }, { json: ['tags', 'attribute'], search: ['title', 'series'] }) as MediaModel
  /** 来源身份在 attribute.metadata；同一 source + sourceId 只对应一条影视。 */
  media.findBySource = (source, sourceId) => media.findWhere(
    `data_source = ? AND json_extract(attribute, '$.metadata.sourceId') = ?`, [source, String(sourceId)])

  const localMedia = records<LocalMedia>(db, 'local_media', {
    id: 'id', libraryId: 'library_id', folderName: 'folder_name', folderPath: 'folder_path', folderHash: 'folder_hash', mediaId: 'media_id', ...timestamps,
  }, { search: ['folderName'] })

  const videos = records<LocalMediaVideo>(db, 'local_media_video', {
    id: 'id', title: 'title', coverPath: 'cover_path', mediaId: 'media_id', videoIndex: 'video_index', mediaPath: 'media_path',
    localMediaId: 'local_media_id', videoType: 'video_type', durationMs: 'duration_ms', width: 'width', height: 'height',
    frameCount: 'frame_count', sizeBytes: 'size_bytes', mtimeMs: 'mtime_ms', missing: 'missing', ...timestamps,
  }, { booleans: ['missing'], order: 'video_index, id', search: ['title'] })

  const tracks = records<MediaTrack>(db, 'media_tracks', {
    mediaId: 'media_id', videoIndex: 'video_index', positionMs: 'position_ms', durationMs: 'duration_ms', completed: 'completed', watchedAt: 'watched_at', ...timestamps,
  }, { keys: ['mediaId', 'videoIndex'], booleans: ['completed'], order: 'watched_at DESC, media_id, video_index' }) as TracksModel
  const saveTrack = db.prepare(`INSERT INTO media_tracks
    (media_id, video_index, position_ms, duration_ms, completed, watched_at, created_at, updated_at)
    VALUES (@mediaId, @videoIndex, @positionMs, @durationMs, @completed, @watchedAt, @now, @now)
    ON CONFLICT(media_id, video_index) DO UPDATE SET position_ms=excluded.position_ms, duration_ms=excluded.duration_ms,
      completed=excluded.completed, watched_at=excluded.watched_at, updated_at=excluded.updated_at
    WHERE excluded.watched_at >= media_tracks.watched_at`)
  tracks.save = (data) => {
    saveTrack.run({ ...data, completed: Number(data.completed), now: Date.now() })
    return tracks.find(data)
  }

  const task = records<TaskRecord>(db, 'task', {
    id: 'id', type: 'type', status: 'status', progress: 'progress', payload: 'payload', result: 'result', error: 'error',
    runAfter: 'run_after', startedAt: 'started_at', finishedAt: 'finished_at', ...timestamps,
  }, { json: ['payload', 'result'] }) as TaskModel
  const changeTask = db.prepare(`UPDATE task SET status=@status, progress=@progress, result=@result, error=@error,
    started_at=@startedAt, finished_at=@finishedAt, updated_at=@now WHERE id=@id AND status=@expected`)
  task.transition = (current, changes) => {
    const next = { ...current, ...changes }
    const changed = changeTask.run({ id: next.id, status: next.status, progress: next.progress,
      result: next.result === null ? null : JSON.stringify(next.result), error: next.error,
      startedAt: next.startedAt, finishedAt: next.finishedAt, now: Date.now(), expected: current.status })
    return changed.changes ? task.find({ id: current.id }) : null
  }
  task.claimNext = db.transaction((now: number) => {
    const row = db.prepare("SELECT id FROM task WHERE status='queued' AND run_after <= ? ORDER BY run_after, created_at, id LIMIT 1").get(now) as { id: number } | undefined
    return row ? task.transition(task.find({ id: row.id })!, { status: 'running', startedAt: now }) : null
  }).immediate as (now: number) => TaskRecord | null

  // Service-owned merges must read and write under the same SQLite lock.
  // Reject async callbacks: network work must finish before this short transaction.
  const transaction = db.transaction((operation: () => unknown) => {
    // 目录重新绑定影视时，本地目录与视频的复合外键需要一起改变。
    db.pragma('defer_foreign_keys = ON')
    const result = operation()
    if (result && typeof (result as Promise<unknown>).then === 'function') throw new TypeError('Catalog transactions must be synchronous')
    return result
  })
  return Object.freeze({
    media, localMedia, videos, tracks, task,
    transaction<T>(operation: () => T): T {
      if (typeof operation !== 'function') throw new TypeError('A transaction callback is required')
      if (operation.constructor?.name === 'AsyncFunction') throw new TypeError('Catalog transactions must be synchronous')
      return transaction.immediate(operation) as T
    },
  }) as CatalogModels
}
