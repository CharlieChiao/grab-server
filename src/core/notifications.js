import crypto from "node:crypto";
import { db, nowIso } from "./database.js";
import { paymentKind } from "./payCodes.js";

const APPID = process.env.WECHAT_APPID || "";
const APP_SECRET = process.env.WECHAT_APP_SECRET || "";
const TEMPLATE_ID = process.env.WECHAT_JOB_RESULT_TEMPLATE_ID || "";
// Bark 推送(iOS App, 锁屏强提醒): 不受微信订阅消息一次性额度限制, 作为任务结果的主通知通道。
// Key 优先读用户配置(users.bark_key 加密存, 设置页绑定); 全局 BARK_DEVICE_KEY 作为未绑定用户的兜底。
const BARK_GLOBAL_KEY = process.env.BARK_DEVICE_KEY || "";
const BARK_SERVER = process.env.BARK_SERVER || "https://api.day.app";
let cachedToken = null;

// Bark 推送: POST /push {device_key, title, body, group, level, volume}; 失败静默(通知非关键路径)
// level: active(默认)/timeSensitive(穿透专注模式)/critical(穿透勿扰+静音, 需在 iOS 给 Bark 授权"关键警报")
async function sendBarkPush(userId, title, body, { group = "抢订任务", sound = "", critical = false } = {}) {
  try {
    const row = db.prepare("SELECT bark_key FROM users WHERE id=?").get(userId);
    const key = row?.bark_key ? decryptOpenId(row.bark_key) : BARK_GLOBAL_KEY;
    if (!key) return { skipped: true };
    const payload = { device_key: key, title, body, group, ...(sound ? { sound } : {}) };
    if (critical) Object.assign(payload, { level: "critical", volume: 8 });
    const res = await fetch(`${BARK_SERVER}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null);
    return json?.code === 200 ? { ok: true } : { ok: false, error: json?.message || "bark push failed" };
  } catch (error) { console.warn("[bark]", String(error?.message || error)); return { ok: false, error: String(error?.message || error) }; }
}

function key() { return crypto.createHash("sha256").update(process.env.GRAB_API_AUTH_SECRET || "").digest(); }
export function encryptOpenId(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}
export function decryptOpenId(value) {
  const raw = Buffer.from(String(value), "base64url"), iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
export function rememberOpenId(userId, openid) {
  db.prepare("INSERT INTO users(id,openid_hash,openid_ciphertext,created_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET openid_ciphertext=excluded.openid_ciphertext,last_seen_at=excluded.last_seen_at").run(userId, userId, encryptOpenId(openid), nowIso(), nowIso());
}
export function notificationStatus(userId) {
  const row = db.prepare("SELECT notification_count,openid_ciphertext FROM users WHERE id=?").get(userId) || {};
  return { configured: !!(APPID && APP_SECRET && TEMPLATE_ID), templateId: TEMPLATE_ID || null, enabled: Number(row.notification_count || 0) > 0, count: Number(row.notification_count || 0), hasOpenId: !!row.openid_ciphertext };
}
export function setJobNotifications(userId, enabled) {
  if (enabled) db.prepare("UPDATE users SET notification_count=notification_count+1, notify_job_result=1 WHERE id=?").run(userId);
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
export async function notifyJobResult(job, options = {}) {
  const row = db.prepare("SELECT openid_ciphertext,notification_count,bark_key FROM users WHERE id=?").get(job.userId);
  const wechatReady = !!(TEMPLATE_ID && APPID && APP_SECRET && Number(row?.notification_count || 0) > 0 && row?.openid_ciphertext);
  if (!wechatReady && !(row?.bark_key || BARK_GLOBAL_KEY)) return { skipped: true }; // 两个通道都不可用才跳过; Bark 不依赖微信配置/额度
  const target = job.target || {};
  const first = Array.isArray(target.courts) ? target.courts[0] || {} : target;
  const venue = String(job.venueId || "").slice(0, 10);
  const court = String(first.court || first.courtUid || "").slice(0, 8);
  const time = String(first.time || target.time || "").slice(0, 5);
  const activity = [venue, court, time].filter(Boolean).join(" ").slice(0, 20) || "\u7403\u573a\u9884\u7ea6";
  const delegatedWechat = paymentKind(job.venueId, target.ext?.payMethod) === "wechat"; // 微信支付任务无论委托与否, 成功即"待本人付款"
  // phrase 字段限 5 个汉字: 任务组任一成功后兄弟任务自动停止(stopped)不能误报为失败
  // 微信支付失败后已用本人余额兜底成功的任务实际无需付款, 报"预约成功"; options.outcome 供组终结补发暂缓通知覆盖文案
  const fallbackPaid = /兜底成功/.test(String(job.result?.message || ""));
  const outcome = options.outcome
    || (fallbackPaid ? "预约成功"
    : job.status === "done" ? (delegatedWechat ? "待本人付款" : "\u9884\u7ea6\u6210\u529f")
    : job.status === "stopped" ? "已自动停止"
    : job.status === "awaiting_payment" ? "待本人付款"
    : "\u9884\u7ea6\u5931\u8d25");
  const amount = Number(target.ext?.totalCost || target.cost || first.cost || 0);
  // Bark 推送(iOS 锁屏提醒): 全量任务结果, 不占微信订阅额度; 待付款事件用 critical 级(穿透勿扰/静音, 需 iOS 授权关键警报)
  const urgent = outcome === "待本人付款";
  sendBarkPush(job.userId, `抢订${outcome}`, `${activity} · ¥${amount.toFixed(2)}\n${String(job.result?.message || "").slice(0, 100)}`, { group: String(job.venueId || "任务"), ...(urgent ? { sound: "bell", critical: true } : {}) }).catch(() => {});
  if (!wechatReady) return { ok: true, via: "bark" }; // 微信不可用/额度尽: Bark 已推, 到此结束
  const body = { touser: decryptOpenId(row.openid_ciphertext), template_id: TEMPLATE_ID, page: "pages/jobs/index", data: {
    thing2: { value: activity },
    phrase5: { value: outcome },
    amount21: { value: amount.toFixed(2) + "\u5143" },
  }};
  const token = await accessToken();
  const response = await fetch("https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=" + encodeURIComponent(token), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (result.errcode && result.errcode !== 0) throw new Error(result.errmsg || "subscribe send failed");
  db.prepare("UPDATE users SET notification_count=MAX(0,notification_count-1), notify_job_result=CASE WHEN notification_count<=1 THEN 0 ELSE 1 END WHERE id=?").run(job.userId);
  return { ok: true };
}
