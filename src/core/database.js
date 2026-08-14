import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = path.join(root, "data");
const dbFile = path.join(dataDir, "grab.sqlite");
fs.mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(dbFile);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, openid_hash TEXT UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credentials (user_id TEXT NOT NULL, venue_id TEXT NOT NULL, credential_json TEXT NOT NULL, updated_at TEXT NOT NULL, ready_ok INTEGER, PRIMARY KEY (user_id, venue_id));
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, venue_id TEXT NOT NULL, target_json TEXT NOT NULL, fire_at TEXT, status TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, device_name TEXT, paired_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_jobs_status_fire ON jobs(status, fire_at);
CREATE TABLE IF NOT EXISTS job_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, attempt INTEGER NOT NULL, planned_at TEXT, dispatched_at TEXT NOT NULL, drift_ms INTEGER, scope_key TEXT, classification TEXT, duration_ms INTEGER, message TEXT);
CREATE TABLE IF NOT EXISTS venue_catalog (venue_id TEXT NOT NULL, court_id TEXT NOT NULL, provider_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (venue_id, court_id), UNIQUE (venue_id, provider_id));
CREATE INDEX IF NOT EXISTS idx_attempts_job ON job_attempts(job_id, attempt);
CREATE TABLE IF NOT EXISTS venue_discovery_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL, venue_name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS venue_discovery_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, stage TEXT NOT NULL, safe_json TEXT NOT NULL, encrypted_payload TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS venue_discovery_drafts (id TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, venue_name TEXT NOT NULL, manifest_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_discovery_events_session ON venue_discovery_events(session_id, id);
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
export const dbPath = () => dbFile;



