import { api } from './api.js'

const STORAGE_KEY = 'anishare.progress'
const PENDING_KEY = 'anishare.progress.pending'
const MIGRATION_KEY = 'anishare.progress.migrated'
const recordKey = (record) => JSON.stringify([record.libraryId || '', record.path])
let loading

function readRecords(key) {
  try {
    return Object.values(JSON.parse(localStorage.getItem(key) || '{}'))
      .filter((record) => record && typeof record.path === 'string' && record.path.startsWith('/') &&
        Number.isFinite(record.time) && Number.isFinite(record.duration) && record.time >= 0 &&
        record.duration > 0 && record.duration <= 7 * 86400)
      .map((record) => ({
        ...(typeof record.libraryId === 'string' && record.libraryId ? { libraryId: record.libraryId } : {}),
        path: record.path,
        title: typeof record.title === 'string' ? record.title.slice(0, 1000) : '',
        time: Math.min(record.time, record.duration),
        duration: record.duration,
        at: Number.isSafeInteger(record.at) && record.at > 0 ? record.at : 1,
        hevc: Boolean(record.hevc),
        poster: typeof record.poster === 'string' && record.poster.startsWith('/') ? record.poster : null,
        seriesPath: typeof record.seriesPath === 'string' && record.seriesPath.startsWith('/') ? record.seriesPath : null,
        seriesTitle: typeof record.seriesTitle === 'string' ? record.seriesTitle.slice(0, 1000) : null,
      }))
  } catch { return [] }
}

function mergeRecords(...groups) {
  const merged = new Map()
  for (const record of groups.flat()) {
    const key = recordKey(record)
    if (!merged.has(key) || record.at >= merged.get(key).at) merged.set(key, record)
  }
  return [...merged.values()].sort((a, b) => b.at - a.at).slice(0, 500)
}

function storeRecords(key, records) {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(mergeRecords(records).map((record) => [recordKey(record), record]))))
    return true
  } catch { return false }
}

function acknowledge(records) {
  const sent = new Map(records.map((record) => [recordKey(record), record.at]))
  storeRecords(PENDING_KEY, readRecords(PENDING_KEY).filter((record) => sent.get(recordKey(record)) !== record.at))
}

function migrateLocalHistory() {
  try {
    if (localStorage.getItem(MIGRATION_KEY) === '2') return
    // Only unsent changes are imported after migration. Mirrored history must not resurrect deletions.
    if (storeRecords(PENDING_KEY, mergeRecords(readRecords(STORAGE_KEY), readRecords(PENDING_KEY)))) {
      localStorage.setItem(MIGRATION_KEY, '2')
    }
  } catch { /* SQLite also works when browser storage is disabled. */ }
}

export function getProgress(libraryId) {
  if (!loading) {
    loading = (async () => {
      migrateLocalHistory()
      const pending = readRecords(PENDING_KEY)
      try {
        if (pending.length) {
          try { await api.importProgress(pending); acknowledge(pending) }
          catch (error) { if (error.status === 401) throw error }
        }
        const { items } = await api.progress()
        const result = mergeRecords(items, readRecords(PENDING_KEY))
        storeRecords(STORAGE_KEY, result)
        return result
      } catch (error) {
        if (error.status === 401) throw error
        return mergeRecords(readRecords(STORAGE_KEY), readRecords(PENDING_KEY))
      }
    })().finally(() => { loading = null })
  }
  return loading.then((items) => libraryId ? items.filter((item) => item.libraryId === libraryId) : items)
}

export async function saveProgress(record, options) {
  const item = { ...record, at: Date.now() }
  storeRecords(STORAGE_KEY, mergeRecords(readRecords(STORAGE_KEY), [item]))
  // Queue before sending, so pagehide remains recoverable even if the page closes before the response.
  storeRecords(PENDING_KEY, mergeRecords(readRecords(PENDING_KEY), [item]))
  try {
    const saved = (await api.saveProgress(item, options)).item
    acknowledge([item])
    return saved
  } catch { return item }
}

export async function deleteProgress(record) {
  try { await api.deleteProgress(record.path, record.libraryId) }
  catch (error) { if (error.status !== 404) throw error }
  const keep = (item) => recordKey(item) !== recordKey(record)
  storeRecords(STORAGE_KEY, readRecords(STORAGE_KEY).filter(keep))
  storeRecords(PENDING_KEY, readRecords(PENDING_KEY).filter(keep))
}
