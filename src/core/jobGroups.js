import crypto from "node:crypto";
import { db, nowIso } from "./database.js";

const rowToGroup = (row) => row && ({
  uid: row.uid,
  createdByUserId: row.created_by_user_id,
  name: row.name,
  successPolicy: row.success_policy,
  repeatWeekly: !!row.repeat_weekly,
  iteration: row.iteration,
  seriesUid: row.series_uid,
  previousGroupUid: row.previous_group_uid || null,
  nextGroupUid: row.next_group_uid || null,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function counts(uid) {
  const rows = db.prepare(`SELECT status FROM jobs WHERE group_uid=? UNION ALL SELECT status FROM job_history WHERE group_uid=?`).all(uid, uid);
  const result = { total: rows.length, pending: 0, running: 0, awaiting_payment: 0, done: 0, failed: 0 };
  for (const row of rows) if (Object.hasOwn(result, row.status)) result[row.status]++;
  return result;
}

export function presentGroup(row) {
  const group = rowToGroup(row);
  if (!group) return null;
  const summary = counts(group.uid);
  let outcome = "pending";
  if (summary.total && group.successPolicy === "any" && summary.done > 0) outcome = "success";
  else if (summary.total && group.successPolicy === "all" && summary.done === summary.total) outcome = "success";
  else if (summary.total && summary.pending + summary.running + summary.awaiting_payment === 0) outcome = "failed";
  return { ...group, summary, outcome };
}

export function createJobGroup(userId, input = {}) {
  const uid = crypto.randomUUID();
  const now = nowIso();
  const name = String(input.name || "未命名任务组").trim().slice(0, 40) || "未命名任务组";
  const policy = input.successPolicy === "any" ? "any" : "all";
  const repeatWeekly = input.repeatWeekly ? 1 : 0;
  const seriesUid = crypto.randomUUID();
  db.prepare("INSERT INTO task_groups(uid,created_by_user_id,name,success_policy,repeat_weekly,iteration,series_uid,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(uid, userId, name, policy, repeatWeekly, 1, seriesUid, "active", now, now);
  return getJobGroup(uid, userId);
}

export function getJobGroup(uid, userId) {
  return presentGroup(db.prepare("SELECT * FROM task_groups WHERE uid=? AND created_by_user_id=?").get(uid, userId));
}

export function requireWritableGroup(uid, userId) {
  const row = db.prepare("SELECT * FROM task_groups WHERE uid=? AND created_by_user_id=? AND status='active'").get(uid, userId);
  if (!row) throw Object.assign(new Error("任务组不存在或已停止"), { statusCode: 404 });
  return row;
}

export function listJobGroups(userId) {
  return db.prepare("SELECT * FROM task_groups WHERE created_by_user_id=? ORDER BY created_at DESC").all(userId).map(presentGroup);
}

export function updateJobGroup(uid, userId, input = {}) {
  const row = requireWritableGroup(uid, userId);
  const name = input.name == null ? row.name : (String(input.name).trim().slice(0, 40) || row.name);
  const policy = input.successPolicy == null ? row.success_policy : input.successPolicy === "any" ? "any" : "all";
  const repeat = input.repeatWeekly == null ? row.repeat_weekly : input.repeatWeekly ? 1 : 0;
  db.prepare("UPDATE task_groups SET name=?,success_policy=?,repeat_weekly=?,updated_at=? WHERE uid=?").run(name, policy, repeat, nowIso(), uid);
  return getJobGroup(uid, userId);
}

export function stopJobGroup(uid, userId) {
  return db.prepare("UPDATE task_groups SET status='stopped',repeat_weekly=0,updated_at=? WHERE uid=? AND created_by_user_id=?").run(nowIso(), uid, userId).changes > 0;
}

const plusWeek = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString();
};
const plusWeekDate = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!m) return value;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 7));
  return date.toISOString().slice(0, 10);
};

export function finalizeAndRepeatGroup(groupUid) {
  if (!groupUid) return null;
  const group = db.prepare("SELECT * FROM task_groups WHERE uid=? AND status='active'").get(groupUid);
  if (!group) return null;
  if (db.prepare("SELECT 1 FROM jobs WHERE group_uid=? LIMIT 1").get(groupUid)) return null;
  const members = db.prepare("SELECT * FROM job_history WHERE group_uid=? ORDER BY created_at").all(groupUid);
  if (!members.length) return null;
  const succeeded = group.success_policy === "any" ? members.some((x) => x.status === "done") : members.every((x) => x.status === "done");
  const now = nowIso();
  if (!group.repeat_weekly) {
    db.prepare("UPDATE task_groups SET status=?,updated_at=? WHERE uid=?").run(succeeded ? "completed" : "failed", now, groupUid);
    return null;
  }
  if (group.next_group_uid) return group.next_group_uid;
  const repeatableMembers = members.filter((member) => {
    if (!member.delegation_id) return true;
    const delegation = db.prepare("SELECT * FROM delegations WHERE id=? AND owner_user_id=? AND delegate_user_id=? AND status='active'").get(member.delegation_id, member.user_id, member.created_by_user_id);
    if (!delegation || (delegation.valid_until && Date.parse(delegation.valid_until) <= Date.now())) return false;
    let allowed = [];
    try { allowed = JSON.parse(delegation.allowed_payments_json); } catch {}
    let target = {};
    try { target = JSON.parse(member.target_json); } catch {}
    const payment = Number(target?.ext?.payMethod) === 40 ? "balance" : Number(target?.ext?.payMethod) === 900 ? "wechat" : null;
    return !!payment && allowed.includes(payment);
  });
  if (!repeatableMembers.length) {
    db.prepare("UPDATE task_groups SET status='stopped',repeat_weekly=0,updated_at=? WHERE uid=?").run(now, groupUid);
    return null;
  }
  const nextUid = crypto.randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO task_groups(uid,created_by_user_id,name,success_policy,repeat_weekly,iteration,series_uid,previous_group_uid,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(nextUid, group.created_by_user_id, group.name, group.success_policy, 1, group.iteration + 1, group.series_uid, groupUid, "active", now, now);
    const insert = db.prepare("INSERT INTO jobs(id,user_id,created_by_user_id,delegation_id,group_uid,venue_id,target_json,fire_at,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const member of repeatableMembers) {
      const target = JSON.parse(member.target_json);
      target.date = plusWeekDate(target.date);
      insert.run(crypto.randomUUID(), member.user_id, member.created_by_user_id, member.delegation_id, nextUid, member.venue_id, JSON.stringify(target), plusWeek(member.fire_at), "pending", null, now, now);
    }
    db.prepare("UPDATE task_groups SET status=?,next_group_uid=?,updated_at=? WHERE uid=?").run(succeeded ? "completed" : "failed", nextUid, now, groupUid);
    db.exec("COMMIT");
    return nextUid;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}