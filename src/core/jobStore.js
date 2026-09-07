import crypto from "node:crypto";
import { db, nowIso } from "./database.js";

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    createdByUserId: row.created_by_user_id || row.user_id,
    delegationId: row.delegation_id || null,
    groupUid: row.group_uid || null,
    delegated: !!row.delegation_id,
    venueId: row.venue_id,
    target: JSON.parse(row.target_json),
    fireAt: row.fire_at,
    status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at || null,
  };
}
export function listJobs() { return db.prepare("SELECT * FROM jobs ORDER BY created_at").all().map(rowToJob); }
export function listJobsForUser(userId) {
  return db.prepare("SELECT * FROM jobs WHERE user_id=? OR created_by_user_id=? ORDER BY created_at DESC").all(userId, userId).map(rowToJob);
}
export function listHistoryForUser(userId) {
  return db.prepare("SELECT * FROM job_history WHERE user_id=? OR created_by_user_id=? ORDER BY archived_at DESC").all(userId, userId).map(rowToJob);
}
export function getJob(id, userId) {
  return rowToJob(db.prepare("SELECT * FROM jobs WHERE id=? AND (user_id=? OR created_by_user_id=?)").get(id, userId, userId))
    || rowToJob(db.prepare("SELECT * FROM job_history WHERE id=? AND (user_id=? OR created_by_user_id=?)").get(id, userId, userId));
}
export function createJob({ userId, createdByUserId = userId, delegationId = null, groupUid = null, venueId, target, fireAt }) {
  const id = crypto.randomUUID(), now = nowIso();
  db.prepare("INSERT OR IGNORE INTO users(id,created_at,last_seen_at) VALUES(?,?,?)").run(userId, now, now);
  db.prepare("INSERT INTO jobs(id,user_id,created_by_user_id,delegation_id,group_uid,venue_id,target_json,fire_at,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, userId, createdByUserId, delegationId, groupUid, venueId, JSON.stringify(target), fireAt || null, "pending", null, now, now);
  return getJob(id, createdByUserId);
}
export function updateJob(id, patch) {
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  if (!row) return null;
  const next = { ...rowToJob(row), ...patch, updatedAt: nowIso() };
  db.prepare("UPDATE jobs SET fire_at=?,status=?,result_json=?,updated_at=? WHERE id=?")
    .run(next.fireAt || null, next.status, next.result ? JSON.stringify(next.result) : null, next.updatedAt, id);
  return next;
}
export function archiveJob(id) {
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  if (!row) return null;
  const archivedAt = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO job_history(id,user_id,created_by_user_id,delegation_id,group_uid,venue_id,target_json,fire_at,status,result_json,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.user_id, row.created_by_user_id, row.delegation_id, row.group_uid, row.venue_id, row.target_json, row.fire_at, row.status, row.result_json, row.created_at, row.updated_at, archivedAt);
    db.prepare("DELETE FROM jobs WHERE id=?").run(id);
    db.exec("COMMIT");
    return rowToJob({ ...row, archived_at: archivedAt });
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}
// 编辑待执行任务的开抢时间与价格(仅 pending 状态, 场地/时段变更需重建任务)
export function editJob(id, userId, { fireAt, cost } = {}) {
  const row = db.prepare("SELECT * FROM jobs WHERE id=? AND (user_id=? OR created_by_user_id=?)").get(id, userId, userId);
  if (!row) return { error: "not found" };
  if (row.status !== "pending") return { error: "仅待执行任务可编辑" };
  const target = JSON.parse(row.target_json);
  if (cost !== undefined && cost !== null) {
    const costNum = Number(cost);
    if (!Number.isFinite(costNum) || costNum <= 0) return { error: "价格必须是正数" };
    target.cost = costNum;
    target.ext = { ...(target.ext || {}), totalCost: costNum };
  }
  let fireAtValue = row.fire_at;
  if (fireAt !== undefined) {
    if (fireAt === null || fireAt === "") fireAtValue = null;
    else {
      const t = Date.parse(fireAt);
      if (!Number.isFinite(t)) return { error: "无效的开抢时间" };
      fireAtValue = new Date(t).toISOString();
    }
  }
  db.prepare("UPDATE jobs SET fire_at=?, target_json=?, updated_at=? WHERE id=?").run(fireAtValue, JSON.stringify(target), nowIso(), id);
  return { job: getJob(id, userId) };
}

export function deleteJob(id, userId) {
  const active = db.prepare("DELETE FROM jobs WHERE id=? AND (user_id=? OR created_by_user_id=?)").run(id, userId, userId).changes;
  const history = db.prepare("DELETE FROM job_history WHERE id=? AND (user_id=? OR created_by_user_id=?)").run(id, userId, userId).changes;
  return active + history > 0;
}
