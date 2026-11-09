-- v6: directory scan state, and the fixed library IDs (default -> bangumi).
CREATE TABLE lib_folder (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER REFERENCES lib_folder(id) ON DELETE CASCADE,
  library_id  TEXT    NOT NULL,
  rel_path    TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  depth       INTEGER NOT NULL CHECK (depth >= 0),
  mtime_ms    INTEGER NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  scanned_at  INTEGER,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'scanned', 'failed', 'missing')),
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (library_id, rel_path)
);
CREATE INDEX lib_folder_parent ON lib_folder(library_id, parent_id, id);
CREATE INDEX lib_folder_status ON lib_folder(library_id, status, id);

-- 媒体库 ID 由配置固定，旧的 default 归入番剧库。
UPDATE local_media SET library_id = 'bangumi' WHERE library_id = 'default';
UPDATE playback_progress SET library_id = 'bangumi' WHERE library_id = 'default';
