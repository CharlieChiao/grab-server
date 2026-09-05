import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = path.join(root, "data");
const dbFile = process.env.GRAB_DB_FILE || path.join(dataDir, "grab.sqlite");
fs.mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(dbFile);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, openid_hash TEXT UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credentials (user_id TEXT NOT NULL, venue_id TEXT NOT NULL, credential_json TEXT NOT NULL, updated_at TEXT NOT NULL, ready_ok INTEGER, PRIMARY KEY (user_id, venue_id));
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, venue_id TEXT NOT NULL, target_json TEXT NOT NULL, fire_at TEXT, status TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS job_history (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, venue_id TEXT NOT NULL, target_json TEXT NOT NULL, fire_at TEXT, status TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_history_user_archived ON job_history(user_id, archived_at DESC);
CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, device_name TEXT, paired_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_jobs_status_fire ON jobs(status, fire_at);
CREATE TABLE IF NOT EXISTS job_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, attempt INTEGER NOT NULL, planned_at TEXT, dispatched_at TEXT NOT NULL, drift_ms INTEGER, scope_key TEXT, classification TEXT, duration_ms INTEGER, message TEXT);
CREATE TABLE IF NOT EXISTS venue_catalog (venue_id TEXT NOT NULL, court_id TEXT NOT NULL, provider_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (venue_id, court_id), UNIQUE (venue_id, provider_id));
CREATE INDEX IF NOT EXISTS idx_attempts_job ON job_attempts(job_id, attempt);
CREATE TABLE IF NOT EXISTS venue_discovery_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL, venue_name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS venue_discovery_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, stage TEXT NOT NULL, safe_json TEXT NOT NULL, encrypted_payload TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS venue_discovery_drafts (id TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, venue_name TEXT NOT NULL, manifest_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_discovery_events_session ON venue_discovery_events(session_id, id);
CREATE TABLE IF NOT EXISTS delegation_invites (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, valid_days INTEGER, allowed_payments_json TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', accepted_by_user_id TEXT, created_at TEXT NOT NULL, accepted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_delegation_invites_owner ON delegation_invites(owner_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, delegate_user_id TEXT NOT NULL, valid_until TEXT, allowed_payments_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT, UNIQUE(owner_user_id, delegate_user_id));
CREATE INDEX IF NOT EXISTS idx_delegations_owner ON delegations(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_delegations_delegate ON delegations(delegate_user_id, status);
CREATE TABLE IF NOT EXISTS task_groups (uid TEXT PRIMARY KEY, created_by_user_id TEXT NOT NULL, name TEXT NOT NULL, success_policy TEXT NOT NULL DEFAULT 'all', repeat_weekly INTEGER NOT NULL DEFAULT 0, iteration INTEGER NOT NULL DEFAULT 1, series_uid TEXT NOT NULL, previous_group_uid TEXT, next_group_uid TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_task_groups_creator ON task_groups(created_by_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS telegram_links (chat_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, user_id TEXT NOT NULL, linked_at TEXT NOT NULL);
`);
const legacyJobsFile = path.join(root, "config", "jobs.json");
function ensureUserColumn(name, definition) {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
}
ensureUserColumn("nickname", "TEXT");
ensureUserColumn("avatar_mime", "TEXT");
ensureUserColumn("avatar_data", "BLOB");
ensureUserColumn("profile_updated_at", "TEXT");
ensureUserColumn("openid_ciphertext", "TEXT");
ensureUserColumn("notify_job_result", "INTEGER NOT NULL DEFAULT 0");
ensureUserColumn("notification_count", "INTEGER NOT NULL DEFAULT 0");
db.prepare("UPDATE users SET notification_count=1 WHERE notification_count=0 AND notify_job_result=1").run();
ensureUserColumn("developer", "INTEGER NOT NULL DEFAULT 0");
function ensureDiscoverySessionColumn(name, definition) {
  const columns = db.prepare("PRAGMA table_info(venue_discovery_sessions)").all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE venue_discovery_sessions ADD COLUMN ${name} ${definition}`);
  }
}
ensureDiscoverySessionColumn("locked_origin", "TEXT");
ensureDiscoverySessionColumn("locked_path", "TEXT");

function ensureTableColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
for (const table of ["jobs", "job_history"]) {
  ensureTableColumn(table, "created_by_user_id", "TEXT");
  ensureTableColumn(table, "delegation_id", "TEXT");
  ensureTableColumn(table, "group_uid", "TEXT");
}

export const nowIso = () => new Date().toISOString();
if (fs.existsSync(legacyJobsFile) && db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n === 0) {
  try {
    const legacyJobs = JSON.parse(fs.readFileSync(legacyJobsFile, "utf8"));
    const now = nowIso();
    const insert = db.prepare("INSERT OR IGNORE INTO jobs(id,user_id,venue_id,target_json,fire_at,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)");
    for (const job of legacyJobs) insert.run(job.id, "legacy-owner", job.venueId, JSON.stringify(job.target), job.fireAt || null, job.status || "pending", job.result ? JSON.stringify(job.result) : null, job.createdAt || now, job.updatedAt || now);
    if (legacyJobs.length) console.log("[db] migrated " + legacyJobs.length + " legacy jobs");
  } catch (e) { console.warn("[db] legacy jobs migration skipped:", e.message); }
}
const archiveCompleted = db.prepare("INSERT OR IGNORE INTO job_history(id,user_id,venue_id,target_json,fire_at,status,result_json,created_at,updated_at,archived_at) SELECT id,user_id,venue_id,target_json,fire_at,status,result_json,created_at,updated_at,? FROM jobs WHERE status IN (\'done\',\'failed\')");
archiveCompleted.run(nowIso());
db.prepare("DELETE FROM jobs WHERE status IN (\'done\',\'failed\')").run();

export const dbPath = () => dbFile;



