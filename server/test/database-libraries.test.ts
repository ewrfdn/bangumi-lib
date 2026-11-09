import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createDatabase } from '../src/model/database.ts'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-libraries-db-'))
after(() => fs.rm(temporary, { recursive: true, force: true }))

const item = {
  path: '/Series/episode.mp4', title: 'Episode 1', time: 120, duration: 1400,
  at: 1000, hevc: true, poster: '/Series/poster.jpg',
  seriesPath: '/Series', seriesTitle: 'Series',
}

test('v1 history migrates into the configured default library and preserves sessions', () => {
  const filename = path.join(temporary, 'v1.sqlite')
  const legacy = new Database(filename)
  legacy.exec(`
    CREATE TABLE playback_progress (
      path TEXT PRIMARY KEY, title TEXT NOT NULL, time REAL NOT NULL,
      duration REAL NOT NULL, at INTEGER NOT NULL, hevc INTEGER NOT NULL DEFAULT 0, poster TEXT
    );
    CREATE INDEX playback_progress_recent ON playback_progress(at DESC);
    CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
    PRAGMA user_version = 1;
  `)
  legacy.prepare('INSERT INTO playback_progress VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(item.path, item.title, item.time, item.duration, item.at, 1, item.poster)
  legacy.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?)').run('token', 'secret', 9999999999999)
  legacy.close()

  let database = createDatabase(filename, 'anime')
  try {
    assert.deepEqual(database.getProgress(item.path), {
      ...item, libraryId: 'anime', seriesPath: null, seriesTitle: null,
    })
    assert.equal(database.getProgress(item.path, 'other'), null)
    assert.equal(database.findSession('token', 'secret', 1000).expires_at, 9999999999999)
    database.writeProgress({ ...item, libraryId: 'movies', title: 'A different file' })
    assert.equal(database.listProgress().length, 2)
  } finally { database.close() }

  // Opening a migrated database again must not move IDs when the default changes.
  database = createDatabase(filename, 'movies')
  try {
    assert.equal(database.getProgress(item.path, 'anime').title, item.title)
    assert.equal(database.getProgress(item.path).title, 'A different file')
    assert.equal(database.listProgress().length, 2)
  } finally { database.close() }
})

test('identical virtual paths have independent progress and metadata per media library', () => {
  const database = createDatabase(':memory:', 'anime')
  try {
    const anime = database.writeProgress(item)
    const movies = database.writeProgress({ ...item, libraryId: 'movies', time: 500, at: 2000, seriesTitle: 'Movie Collection' })
    assert.equal(anime.libraryId, 'anime')
    assert.equal(movies.libraryId, 'movies')
    assert.equal(database.getProgress(item.path, 'anime').time, 120)
    assert.equal(database.getProgress(item.path, 'movies').time, 500)
    assert.deepEqual(database.listProgress('movies'), [movies])
    database.importProgress([
      { ...item, libraryId: 'anime', time: 2, at: 500 },
      { ...item, libraryId: 'movies', time: 600, at: 3000 },
    ])
    assert.equal(database.getProgress(item.path, 'anime').time, 120)
    assert.equal(database.getProgress(item.path, 'movies').time, 600)
    assert.equal(database.getProgress(item.path, 'movies').seriesPath, '/Series')
    database.deleteProgress(item.path, 'movies')
    assert.equal(database.getProgress(item.path, 'movies'), null)
    assert.equal(database.getProgress(item.path, 'anime').time, 120)
    assert.equal(database.info().progressCount, 1)
  } finally { database.close() }
})

test('failed multi-library import rolls back every row in the batch', () => {
  const database = createDatabase(':memory:', 'anime')
  try {
    database.writeProgress(item)
    assert.throws(() => database.importProgress([
      { ...item, libraryId: 'movies', at: 2000 },
      { ...item, libraryId: 'anime', duration: -1, at: 3000 },
    ]))
    assert.equal(database.listProgress().length, 1)
    assert.equal(database.getProgress(item.path, 'movies'), null)
    assert.equal(database.getProgress(item.path, 'anime').duration, 1400)
  } finally { database.close() }
})
