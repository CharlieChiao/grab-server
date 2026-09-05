import crypto from "node:crypto";
import { db, nowIso } from "./database.js";
import { paymentKind } from "./payCodes.js";

const INVITE_TTL_MS = 7 * 86400000;
const PAYMENT_TYPES = new Set(["balance", "wechat"]);

function parsePayments(value) {
  try { return JSON.parse(value || "[]").filter((item) => PAYMENT_TYPES.has(item)); } catch { return []; }
}
function profile(userId) {
  const row = db.prepare("SELECT nickname,avatar_mime,avatar_data FROM users WHERE id=?").get(userId) || {};
  return {
    userId,
    nickname: row.nickname || "微信用户",
    avatar: row.avatar_data ? `data:${row.avatar_mime || "image/jpeg"};base64,${Buffer.from(row.avatar_data).toString("base64")}` : "",
  };
}
function normalizeDays(value) {
  if (value == null || value === "") return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("有效期天数必须是 1 到 3650 的整数");
  return days;
}
export function normalizePayments(value) {
  const payments = [...new Set(Array.isArray(value) ? value : [])].filter((item) => PAYMENT_TYPES.has(item));
  if (!payments.length) throw new Error("至少允许一种支付方式");
  return payments;
}
function hashToken(token) { return crypto.createHash("sha256").update(String(token)).digest("hex"); }
function hashPassword(password, salt) { return crypto.scryptSync(String(password), salt, 32).toString("hex"); }
function safeEqual(a, b) {
  const left = Buffer.from(String(a), "hex"), right = Buffer.from(String(b), "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function isActive(row) {
  return !!row && row.status === "active" && (!row.valid_until || Date.parse(row.valid_until) > Date.now());
}
function delegationResponse(row, other) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    delegateUserId: row.delegate_user_id,
    validUntil: row.valid_until || null,
    unlimited: !row.valid_until,
    allowedPayments: parsePayments(row.allowed_payments_json),
    status: isActive(row) ? "active" : row.status === "active" ? "expired" : row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    user: other,
  };
}

export function createDelegationInvite(ownerUserId, input = {}) {
  const validDays = normalizeDays(input.validDays);
  const allowedPayments = normalizePayments(input.allowedPayments);
  const token = crypto.randomBytes(24).toString("base64url");
  const password = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const salt = crypto.randomBytes(16).toString("hex");
  const now = nowIso(), expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO delegation_invites(id,owner_user_id,token_hash,password_hash,password_salt,valid_days,allowed_payments_json,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, ownerUserId, hashToken(token), hashPassword(password, salt), salt, validDays, JSON.stringify(allowedPayments), expiresAt, "pending", now);
  return { id, token, password, validDays, unlimited: validDays == null, allowedPayments, inviteExpiresAt: expiresAt, owner: profile(ownerUserId) };
}

export function getInvitePreview(token) {
  const row = db.prepare("SELECT * FROM delegation_invites WHERE token_hash=?").get(hashToken(token));
  if (!row || row.status !== "pending" || Date.parse(row.expires_at) <= Date.now()) return null;
  return { validDays: row.valid_days, unlimited: row.valid_days == null, allowedPayments: parsePayments(row.allowed_payments_json), inviteExpiresAt: row.expires_at, owner: profile(row.owner_user_id) };
}

export function acceptDelegationInvite(token, password, delegateUserId) {
  const row = db.prepare("SELECT * FROM delegation_invites WHERE token_hash=?").get(hashToken(token));
  if (!row || row.status !== "pending") throw Object.assign(new Error("邀请不存在或已使用"), { statusCode: 404 });
  if (Date.parse(row.expires_at) <= Date.now()) throw Object.assign(new Error("邀请已过期"), { statusCode: 410 });
  if (row.owner_user_id === delegateUserId) throw Object.assign(new Error("不能授权给自己"), { statusCode: 400 });
  if (!safeEqual(hashPassword(password, row.password_salt), row.password_hash)) throw Object.assign(new Error("校验密码错误"), { statusCode: 403 });
  const now = nowIso();
  const validUntil = row.valid_days == null ? null : new Date(Date.now() + Number(row.valid_days) * 86400000).toISOString();
  const existing = db.prepare("SELECT id,created_at FROM delegations WHERE owner_user_id=? AND delegate_user_id=?").get(row.owner_user_id, delegateUserId);
  const id = existing?.id || crypto.randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO delegations(id,owner_user_id,delegate_user_id,valid_until,allowed_payments_json,status,created_at,updated_at,revoked_at)
      VALUES(?,?,?,?,?,'active',?,?,NULL)
      ON CONFLICT(owner_user_id,delegate_user_id) DO UPDATE SET valid_until=excluded.valid_until,allowed_payments_json=excluded.allowed_payments_json,status='active',updated_at=excluded.updated_at,revoked_at=NULL`)
      .run(id, row.owner_user_id, delegateUserId, validUntil, row.allowed_payments_json, existing?.created_at || now, now);
    db.prepare("UPDATE delegation_invites SET status='accepted',accepted_by_user_id=?,accepted_at=? WHERE id=?").run(delegateUserId, now, row.id);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  return getDelegation(id, row.owner_user_id);
}

export function getDelegation(id, requesterId) {
  const row = db.prepare("SELECT * FROM delegations WHERE id=?").get(id);
  if (!row || (row.owner_user_id !== requesterId && row.delegate_user_id !== requesterId)) return null;
  const oppositeId = requesterId === row.owner_user_id ? row.delegate_user_id : row.owner_user_id;
  return delegationResponse(row, profile(oppositeId));
}
export function listDelegates(ownerUserId) {
  return db.prepare("SELECT * FROM delegations WHERE owner_user_id=? ORDER BY updated_at DESC").all(ownerUserId)
    .map((row) => delegationResponse(row, profile(row.delegate_user_id)));
}
export function listPrincipals(delegateUserId) {
  return db.prepare("SELECT * FROM delegations WHERE delegate_user_id=? ORDER BY updated_at DESC").all(delegateUserId)
    .map((row) => delegationResponse(row, profile(row.owner_user_id))).filter((item) => item.status === "active");
}
export function getActiveDelegation(ownerUserId, delegateUserId) {
  const row = db.prepare("SELECT * FROM delegations WHERE owner_user_id=? AND delegate_user_id=?").get(ownerUserId, delegateUserId);
  return isActive(row) ? row : null;
}
export function updateDelegation(id, ownerUserId, input = {}) {
  const row = db.prepare("SELECT * FROM delegations WHERE id=? AND owner_user_id=?").get(id, ownerUserId);
  if (!row) return null;
  const validDays = normalizeDays(input.validDays);
  const validUntil = validDays == null ? null : new Date(Date.now() + validDays * 86400000).toISOString();
  const payments = normalizePayments(input.allowedPayments);
  db.prepare("UPDATE delegations SET valid_until=?,allowed_payments_json=?,status='active',updated_at=?,revoked_at=NULL WHERE id=?")
    .run(validUntil, JSON.stringify(payments), nowIso(), id);
  return getDelegation(id, ownerUserId);
}
export function revokeDelegation(id, requesterId) {
  const row = db.prepare("SELECT * FROM delegations WHERE id=? AND (owner_user_id=? OR delegate_user_id=?)").get(id, requesterId, requesterId);
  if (!row) return false;
  const now = nowIso();
  db.prepare("UPDATE delegations SET status='revoked',updated_at=?,revoked_at=? WHERE id=?").run(now, now, id);
  return true;
}
export function paymentTypeFromCode(venueId, code) {
  return paymentKind(venueId, code);
}
