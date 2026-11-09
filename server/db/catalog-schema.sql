-- Simplified target: 5 business tables + 2 existing system tables.
-- media_tracks replaces legacy playback_progress after a separate data migration.
-- Empty-database reference; existing databases use the versioned migrations.
-- Paths are relative; timestamps and durations use integer milliseconds.
PRAGMA foreign_keys = ON;
BEGIN;

CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  cover TEXT,
  media_type TEXT NOT NULL DEFAULT 'anime',
  data_source TEXT,
  data_source_url TEXT,
  season INTEGER NOT NULL DEFAULT 1 CHECK (typeof(season) = 'integer' AND season >= 1),
  episode_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(episode_count) = 'integer' AND episode_count >= 0),
  description TEXT NOT NULL DEFAULT '',
  rating REAL CHECK (rating IS NULL OR rating BETWEEN 0 AND 10),
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  attribute TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attribute) AND json_type(attribute) = 'object'),
  aired_on TEXT,
  series TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX media_type_idx ON media(media_type, id);
CREATE INDEX media_series_idx ON media(series, id);

CREATE TABLE local_media (
  id INTEGER PRIMARY KEY,
  library_id TEXT NOT NULL DEFAULT 'default',
  folder_name TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  folder_hash TEXT NOT NULL,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, media_id),
  UNIQUE (library_id, folder_hash)
);
CREATE INDEX local_media_media ON local_media(media_id, id);

CREATE TABLE local_media_video (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  cover_path TEXT,
  media_id INTEGER NOT NULL,
  video_index REAL NOT NULL DEFAULT 0 CHECK (video_index >= 0),
  media_path TEXT NOT NULL CHECK (length(media_path) > 0),
  local_media_id INTEGER NOT NULL,
  video_type TEXT NOT NULL DEFAULT 'main' CHECK (video_type IN ('main', 'extra')),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  mtime_ms INTEGER NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (local_media_id, media_id) REFERENCES local_media(id, media_id) ON DELETE RESTRICT,
  UNIQUE (local_media_id, media_path)
);
CREATE INDEX local_media_video_order ON local_media_video(local_media_id, video_type, video_index, id);
CREATE INDEX local_media_video_media ON local_media_video(media_id, video_index, id);

-- Viewing history: one record per media + episode index, shared across files.
CREATE TABLE media_tracks (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  video_index REAL NOT NULL CHECK (video_index >= 0),
  position_ms INTEGER NOT NULL DEFAULT 0 CHECK (position_ms >= 0),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  watched_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, video_index),
  CHECK (duration_ms = 0 OR position_ms <= duration_ms)
);
CREATE INDEX media_tracks_recent ON media_tracks(watched_at DESC, media_id, video_index);
CREATE INDEX media_tracks_media_recent ON media_tracks(media_id, watched_at DESC, video_index);

CREATE TABLE task (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  error TEXT,
  run_after INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX task_runnable ON task(status, run_after, created_at, id);
CREATE INDEX task_type_recent ON task(type, created_at DESC, id DESC);

-- Existing system tables kept unchanged.
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE app_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
COMMIT;
