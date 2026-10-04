import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

let sqlite: DatabaseSync | null = null

export function getSqlite(): DatabaseSync {
  if (sqlite) return sqlite
  const dbPath = join(app.getPath('userData'), 'todopet.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  sqlite = new DatabaseSync(dbPath)
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  if(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get() && !sqlite.prepare("SELECT name FROM sqlite_master WHERE name='health_record_sessions'").get()) {
    const backupDir=join(app.getPath('userData'),'backups');mkdirSync(backupDir,{recursive:true})
    // SQLite creates a consistent snapshot, including committed WAL contents.
    sqlite.prepare('VACUUM INTO ?').run(join(backupDir,'before-health-records-'+Date.now()+'.db'))
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'none',
      due_at TEXT,
      remind_at TEXT,
      obsidian_path TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      sync_state TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_presets (
      kind TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      interval_minutes INTEGER NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      weekdays_json TEXT NOT NULL,
      next_trigger_at TEXT,
      last_acknowledged_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reminder_occurrences (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      fired_at TEXT,
      acknowledged_at TEXT,
      snoozed_from_id TEXT,
      title TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reminder_due_idx ON reminder_occurrences(status, scheduled_at);
    CREATE TABLE IF NOT EXISTS sync_records (
      task_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      db_revision INTEGER NOT NULL,
      last_synced_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_kind_idx ON notes(kind, created_at DESC);
    CREATE TABLE IF NOT EXISTS health_session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active INTEGER NOT NULL DEFAULT 0,
      started_at TEXT
    );
  `)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS health_record_sessions (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, state TEXT NOT NULL, heartbeat_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS health_one_open_session ON health_record_sessions ((1)) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS health_segments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES health_record_sessions(id), posture TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
    CREATE TABLE IF NOT EXISTS health_events (id TEXT PRIMARY KEY, session_id TEXT REFERENCES health_record_sessions(id), kind TEXT NOT NULL, occurred_at TEXT NOT NULL, source TEXT NOT NULL, request_id TEXT UNIQUE, occurrence_id TEXT UNIQUE, deleted_at TEXT);
    CREATE TABLE IF NOT EXISTS health_record_audit (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT NOT NULL, changed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS health_record_migrations (version INTEGER PRIMARY KEY);
    CREATE INDEX IF NOT EXISTS health_segment_start ON health_segments(started_at);
    CREATE INDEX IF NOT EXISTS health_event_time ON health_events(occurred_at);
  `)
  sqlite.prepare('INSERT OR IGNORE INTO health_session (id, active, started_at) VALUES (1, 0, NULL)').run()
  // 轻迁移：巡逻日志需要完成时间。老库补列，历史已完成任务以 updated_at 近似回填。
  const columns = sqlite.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'completed_at')) {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN completed_at TEXT')
  }
  sqlite.exec("UPDATE tasks SET completed_at = updated_at WHERE status = 'completed' AND completed_at IS NULL")
  return sqlite
}

export function closeDatabase(): void {
  sqlite?.close()
  sqlite = null
}
