import crypto from "node:crypto";
import { db, nowIso } from "./database.js";

function rowToJob(row) {
  if (!row) return null;
  return { id: row.id, userId: row.user_id, venueId: row.venue_id, target: JSON.parse(row.target_json), fireAt: row.fire_at, status: row.status, result: row.result_json ? JSON.parse(row.result_json) : null, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function listJobs() { return db.prepare("SELECT * FROM jobs ORDER BY created_at").all().map(rowToJob); }
export function listJobsForUser(userId) { return db.prepare("SELECT * FROM jobs WHERE user_id=? ORDER BY created_at").all(userId).map(rowToJob); }
export function getJob(id, userId) { return rowToJob(db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=?").get(id, userId)); }
export function createJob({ userId, venueId, target, fireAt }) { const id = crypto.randomUUID(), now = nowIso(); db.prepare("INSERT OR IGNORE INTO users(id, created_at, last_seen_at) VALUES(?, ?, ?)").run(userId, now, now); db.prepare("INSERT INTO jobs(id,user_id,venue_id,target_json,fire_at,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id,userId,venueId,JSON.stringify(target),fireAt || null,"pending",null,now,now); return getJob(id, userId); }
export function updateJob(id, patch) { const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(id); if (!row) return null; const next = { ...rowToJob(row), ...patch, updatedAt: nowIso() }; db.prepare("UPDATE jobs SET fire_at=?, status=?, result_json=?, updated_at=? WHERE id=?").run(next.fireAt || null, next.status, next.result ? JSON.stringify(next.result) : null, next.updatedAt, id); return next; }
export function deleteJob(id, userId) { return db.prepare("DELETE FROM jobs WHERE id=? AND user_id=?").run(id, userId).changes > 0; }
