import crypto from "node:crypto";
import { db, nowIso } from "./database.js";

const APPID = process.env.WECHAT_APPID || "";
const APP_SECRET = process.env.WECHAT_APP_SECRET || "";
const TEMPLATE_ID = process.env.WECHAT_JOB_RESULT_TEMPLATE_ID || "";
let cachedToken = null;

function key() { return crypto.createHash("sha256").update(process.env.GRAB_API_AUTH_SECRET || "").digest(); }
export function encryptOpenId(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}
function decryptOpenId(value) {
  const raw = Buffer.from(String(value), "base64url"), iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
export function rememberOpenId(userId, openid) {
  db.prepare("INSERT INTO users(id,openid_hash,openid_ciphertext,created_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET openid_ciphertext=excluded.openid_ciphertext,last_seen_at=excluded.last_seen_at").run(userId, userId, encryptOpenId(openid), nowIso(), nowIso());
}
export function notificationStatus(userId) {
  const row = db.prepare("SELECT notify_job_result,openid_ciphertext FROM users WHERE id=?").get(userId) || {};
  return { configured: !!(APPID && APP_SECRET && TEMPLATE_ID), templateId: TEMPLATE_ID || null, enabled: !!row.notify_job_result, hasOpenId: !!row.openid_ciphertext };
}
export function setJobNotifications(userId, enabled) {
  db.prepare("UPDATE users SET notify_job_result=? WHERE id=?").run(enabled ? 1 : 0, userId);
  return notificationStatus(userId);
}
async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
  const query = new URLSearchParams({ grant_type: "client_credential", appid: APPID, secret: APP_SECRET });
  const data = await (await fetch("https://api.weixin.qq.com/cgi-bin/token?" + query)).json();
  if (!data.access_token) throw new Error(data.errmsg || "access token unavailable");
  cachedToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 7200) * 1000 };
  return cachedToken.value;
}
export async function notifyJobResult(job) {
  const row = db.prepare("SELECT openid_ciphertext,notify_job_result FROM users WHERE id=?").get(job.userId);
  if (!TEMPLATE_ID || !APPID || !APP_SECRET || !row?.notify_job_result || !row.openid_ciphertext) return { skipped: true };
  const target = job.target || {};
  const first = Array.isArray(target.courts) ? target.courts[0] || {} : target;
  const venue = String(job.venueId || "").slice(0, 10);
  const court = String(first.court || first.courtUid || "").slice(0, 8);
  const time = String(first.time || target.time || "").slice(0, 5);
  const activity = [venue, court, time].filter(Boolean).join(" ").slice(0, 20) || "\u7403\u573a\u9884\u7ea6";
  const outcome = job.status === "done" ? "\u9884\u7ea6\u6210\u529f" : "\u9884\u7ea6\u5931\u8d25";
  const amount = Number(target.ext?.totalCost || target.cost || first.cost || 0);
  const body = { touser: decryptOpenId(row.openid_ciphertext), template_id: TEMPLATE_ID, page: "pages/jobs/index", data: {
    thing2: { value: activity },
    phrase5: { value: outcome },
    amount21: { value: amount.toFixed(2) + "\u5143" },
  }};
  const token = await accessToken();
  const response = await fetch("https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=" + encodeURIComponent(token), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (result.errcode && result.errcode !== 0) throw new Error(result.errmsg || "subscribe send failed");
  db.prepare("UPDATE users SET notify_job_result=0 WHERE id=?").run(job.userId);
  return { ok: true };
}
