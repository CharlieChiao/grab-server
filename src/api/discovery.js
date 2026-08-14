import crypto from "node:crypto";
import express from "express";
import { db, nowIso } from "../core/database.js";

const router = express.Router();
const STAGES = new Set(["account", "courts", "slots", "booking"]);
const PAYMENT_PATTERN = /(payment|paySign|prepay|unifiedorder|cashier|银行卡|支付密码|wechatpay|wxpay)/i;
const SECRET_KEY_PATTERN = /(authorization|token|visitor|session|openid|credential|ticket)/i;
const DROP_KEY_PATTERN = /(password|passwd|paySign|prepay|bank|cardNo|cvv|idCard|paymentToken|privateKey)/i;
const MAX_EVENTS = 160;

function ownedSession(id, userId) {
  return db.prepare("SELECT * FROM venue_discovery_sessions WHERE id=? AND user_id=?").get(id, userId);
}

function safeValue(value, depth = 0) {
  if (depth > 7) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => safeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      if (DROP_KEY_PATTERN.test(key)) continue;
      output[key] = SECRET_KEY_PATTERN.test(key) ? "[credential]" : safeValue(item, depth + 1);
    }
    return output;
  }
  if (typeof value === "string") return value.length > 300 ? value.slice(0, 300) + "…" : value;
  return value;
}

function shape(value, depth = 0) {
  if (depth > 6) return "unknown";
  if (Array.isArray(value)) return { type: "array", item: value.length ? shape(value[0], depth + 1) : "unknown" };
  if (value && typeof value === "object") return { type: "object", fields: Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, shape(item, depth + 1)])) };
  if (value === null) return "null";
  return typeof value;
}

function encryptionKey() {
  const secret = process.env.GRAB_API_AUTH_SECRET;
  if (!secret) throw new Error("GRAB_API_AUTH_SECRET is required for discovery encryption");
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function endpointSummary(event) {
  let url;
  try { url = new URL(event.url); } catch { return null; }
  if (url.protocol !== "https:") return null;
  return {
    method: String(event.method || "GET").toUpperCase(),
    baseUrl: url.origin,
    path: url.pathname,
    queryKeys: [...url.searchParams.keys()].slice(0, 30),
    requestHeaders: Object.keys(event.requestHeaders || {}).filter((name) => !/cookie|pay|card/i.test(name)).slice(0, 40),
    requestShape: shape(event.requestBody),
    responseShape: shape(event.responseBody),
    statusCode: Number(event.statusCode) || null,
  };
}

function compileManifest(session, rows) {
  const apis = {};
  const score = (stage, item) => {
    const endpoint = item?.endpoint || {};
    const haystack = JSON.stringify(endpoint).toLowerCase();
    let value = endpoint.statusCode && endpoint.statusCode < 400 ? 2 : 0;
    if (stage === "account") value += (haystack.match(/login|member|account|customer|balance|phone|profile/g) || []).length * 3;
    if (stage === "courts") value += (haystack.match(/court|classroom|venue|project|stadium|field|场地|球场/g) || []).length * 3;
    if (stage === "slots") value += (haystack.match(/slot|schedule|appoint|datetime|begin|end|price|cost|时段|价格/g) || []).length * 3;
    if (stage === "booking") {
      value += endpoint.method === "POST" ? 5 : 0;
      value += (haystack.match(/save|create|submit|booking|appointment|order|reserve|预约|下单/g) || []).length * 4;
      if (/payment|pay|cashier|支付/.test(haystack)) value -= 100;
    }
    return value;
  };
  for (const stage of STAGES) {
    const candidates = rows.filter((row) => row.stage === stage).map((row) => JSON.parse(row.safe_json));
    const candidate = candidates.sort((a, b) => score(stage, b) - score(stage, a))[0];
    if (candidate) apis[stage] = { ...candidate.endpoint, confidenceScore: score(stage, candidate) };
  }
  const required = ["account", "courts", "slots", "booking"];
  const missing = required.filter((stage) => !apis[stage]);
  return {
    schemaVersion: 1,
    kind: "declarative-http-draft",
    venue: { name: session.venue_name },
    apis,
    safety: { arbitraryCode: false, paymentCaptured: false, secretsEncrypted: true },
    missing,
    activation: missing.length ? "capture-required" : "self-test-required",
  };
}

router.post("/venue-discovery/sessions", (req, res) => {
  if (!req.deviceAuthenticated) return res.status(403).json({ error: "请先用小程序扫码配对电脑" });
  const venueName = String(req.body?.venueName || "").trim().slice(0, 100);
  if (!venueName) return res.status(400).json({ error: "球场名称不能为空" });
  const id = crypto.randomUUID(), now = nowIso();
  db.prepare("INSERT INTO venue_discovery_sessions(id,user_id,device_id,venue_name,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, req.user.id, req.user.deviceId || req.get("x-device-id"), venueName, "capturing", now, now);
  res.json({ ok: true, sessionId: id, stages: [...STAGES] });
});

router.post("/venue-discovery/sessions/:id/events", (req, res) => {
  if (!req.deviceAuthenticated) return res.status(403).json({ error: "设备未配对" });
  const session = ownedSession(req.params.id, req.user.id);
  if (!session || session.status !== "capturing") return res.status(404).json({ error: "发现会话不存在或已结束" });
  const stage = String(req.body?.stage || "");
  const event = req.body?.event || {};
  if (!STAGES.has(stage)) return res.status(400).json({ error: "未知引导阶段" });
  if (PAYMENT_PATTERN.test(String(event.url || "")) || PAYMENT_PATTERN.test(JSON.stringify(event.requestBody || {}))) {
    return res.status(422).json({ error: "支付接口和支付参数不会被采集", ignored: true });
  }
  const count = db.prepare("SELECT COUNT(*) AS n FROM venue_discovery_events WHERE session_id=?").get(session.id).n;
  if (count >= MAX_EVENTS) return res.status(429).json({ error: "本次发现记录已达到上限" });
  const endpoint = endpointSummary(event);
  if (!endpoint) return res.status(400).json({ error: "只允许采集 HTTPS 接口" });
  const safe = { endpoint, capturedAt: nowIso() };
  const encryptedPayload = encrypt({
    method: event.method,
    url: event.url,
    requestHeaders: safeValue(event.requestHeaders || {}),
    requestBody: safeValue(event.requestBody),
    responseBody: safeValue(event.responseBody),
  });
  const now = nowIso();
  db.prepare("INSERT INTO venue_discovery_events(session_id,stage,safe_json,encrypted_payload,created_at) VALUES(?,?,?,?,?)")
    .run(session.id, stage, JSON.stringify(safe), encryptedPayload, now);
  db.prepare("UPDATE venue_discovery_sessions SET updated_at=? WHERE id=?").run(now, session.id);
  res.json({ ok: true, accepted: true, count: count + 1, endpoint });
});

router.post("/venue-discovery/sessions/:id/finalize", (req, res) => {
  if (!req.deviceAuthenticated) return res.status(403).json({ error: "设备未配对" });
  const session = ownedSession(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: "发现会话不存在" });
  const rows = db.prepare("SELECT stage,safe_json FROM venue_discovery_events WHERE session_id=? ORDER BY id").all(session.id);
  const manifest = compileManifest(session, rows);
  const draftId = crypto.randomUUID(), now = nowIso();
  db.prepare("INSERT INTO venue_discovery_drafts(id,session_id,user_id,venue_name,manifest_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET manifest_json=excluded.manifest_json,status=excluded.status,updated_at=excluded.updated_at")
    .run(draftId, session.id, req.user.id, session.venue_name, JSON.stringify(manifest), manifest.activation, now, now);
  db.prepare("UPDATE venue_discovery_sessions SET status='finalized',updated_at=? WHERE id=?").run(now, session.id);
  res.json({ ok: true, draftId, manifest });
});

router.delete("/venue-discovery/sessions/:id", (req, res) => {
  if (!req.deviceAuthenticated) return res.status(403).json({ error: "设备未配对" });
  const session = ownedSession(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: "发现会话不存在" });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM venue_discovery_events WHERE session_id=?").run(session.id);
    db.prepare("DELETE FROM venue_discovery_drafts WHERE session_id=?").run(session.id);
    db.prepare("DELETE FROM venue_discovery_sessions WHERE id=?").run(session.id);
    db.exec("COMMIT");
    res.json({ ok: true, deleted: true });
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    res.status(500).json({ error: "取消发现失败" });
  }
});
router.get("/venue-discovery/sessions/:id", (req, res) => {
  const session = ownedSession(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: "发现会话不存在" });
  const counts = Object.fromEntries(db.prepare("SELECT stage,COUNT(*) AS n FROM venue_discovery_events WHERE session_id=? GROUP BY stage").all(session.id).map((row) => [row.stage, row.n]));
  const draft = db.prepare("SELECT manifest_json,status FROM venue_discovery_drafts WHERE session_id=?").get(session.id);
  res.json({ ok: true, session: { id: session.id, venueName: session.venue_name, status: session.status, counts }, draft: draft ? { status: draft.status, manifest: JSON.parse(draft.manifest_json) } : null });
});

export default router;