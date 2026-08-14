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

function activeSession(id, userId) {
  const session = ownedSession(id, userId);
  return session && (session.status === "capturing" || session.status === "locked") ? session : null;
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

function keywordTokens(name) {
  const input = String(name || "").toLowerCase();
  const compact = input.replace(/\s+/g, "");
  const words = input.split(/[\s\\-_/]+/).filter((word) => word.length >= 2);
  return [...new Set([compact, ...words].filter(Boolean))];
}

function baseDomain(baseUrl) {
  try {
    const parts = new URL(baseUrl).hostname.toLowerCase().split(".");
    const suffix = parts.slice(-2).join(".");
    const multiPart = new Set(["com.cn", "net.cn", "org.cn", "gov.cn", "co.uk"]);
    return multiPart.has(suffix) && parts.length >= 3 ? parts.slice(-3).join(".") : suffix;
  } catch { return ""; }
}

function candidateScore(session, event, endpoint, existingRows) {
  const sessionText = JSON.stringify({
    url: event.url,
    request: safeValue(event.requestBody || {}),
    response: safeValue(event.responseBody || {}),
  }).toLowerCase().replace(/\s+/g, "");
  const tokens = keywordTokens(session.venue_name);
  const nameHits = tokens.filter((token) => sessionText.includes(token)).length;
  const domain = baseDomain(endpoint.baseUrl);
  const domainCount = existingRows.filter((row) => {
    try { return baseDomain(JSON.parse(row.safe_json)?.endpoint?.baseUrl) === domain; } catch { return false; }
  }).length;
  return {
    score: nameHits * 100 + Math.min(domainCount, 20) * 8 + (endpoint.statusCode && endpoint.statusCode < 400 ? 2 : 0),
    nameMatched: nameHits > 0,
    domain,
    domainCount,
  };
}

function compileManifest(session, rows) {
  const apis = {};
  const score = (stage, item) => {
    const endpoint = item?.endpoint || {};
    const haystack = JSON.stringify(endpoint).toLowerCase();
    let value = Number(item?.candidate?.score || 0) + (endpoint.statusCode && endpoint.statusCode < 400 ? 2 : 0);
    if (stage === "account") value += (haystack.match(/login|member|account|customer|balance|phone|profile/g) || []).length * 3;
    if (stage === "courts") value += (haystack.match(/court|classroom|venue|project|stadium|field/g) || []).length * 3;
    if (stage === "slots") value += (haystack.match(/slot|schedule|appoint|datetime|begin|end|price|cost/g) || []).length * 3;
    if (stage === "booking") {
      value += endpoint.method === "POST" ? 5 : 0;
      value += (haystack.match(/save|create|submit|booking|appointment|order|reserve/g) || []).length * 4;
      if (/payment|pay|cashier/.test(haystack)) value -= 100;
    }
    return value;
  };
  for (const stage of STAGES) {
    const candidates = rows.filter((row) => row.stage === stage).map((row) => JSON.parse(row.safe_json)).filter((item) => item.annotation?.selected !== false);
    const candidate = candidates.sort((a, b) => score(stage, b) - score(stage, a))[0];
    if (candidate) apis[stage] = {
      ...candidate.endpoint,
      confidenceScore: score(stage, candidate),
      label: candidate.annotation?.label || null,
      tags: candidate.annotation?.tags || [],
      note: candidate.annotation?.note || null,
      relevance: candidate.candidate?.score || 0,
    };
  }
  const required = ["account", "courts", "slots", "booking"];
  const missing = required.filter((stage) => !apis[stage]);
  return {
    schemaVersion: 1,
    kind: "declarative-http-draft",
    venue: { name: session.venue_name, entry: session.locked_origin ? { origin: session.locked_origin, path: session.locked_path } : null },
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
  if (!req.deviceAuthenticated) return res.status(403).json({ error: "\u8bbe\u5907\u672a\u914d\u5bf9" });
  const session = activeSession(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: "\u53d1\u73b0\u4f1a\u8bdd\u4e0d\u5b58\u5728\u6216\u5df2\u7ed3\u675f" });
  const stage = String(req.body?.stage || "");
  const event = req.body?.event || {};
  if (!STAGES.has(stage)) return res.status(400).json({ error: "\u672a\u77e5\u5f15\u5bfc\u9636\u6bb5" });
  if (PAYMENT_PATTERN.test(String(event.url || "")) || PAYMENT_PATTERN.test(JSON.stringify(event.requestBody || {}))) {
    return res.status(422).json({ error: "\u652f\u4ed8\u76f8\u5173\u5185\u5bb9\u4e0d\u4f1a\u88ab\u6536\u96c6", ignored: true });
  }
  const count = db.prepare("SELECT COUNT(*) AS n FROM venue_discovery_events WHERE session_id=?").get(session.id).n;
  if (count >= MAX_EVENTS) return res.status(429).json({ error: "\u672c\u6b21\u53d1\u73b0\u8bb0\u5f55\u5df2\u8fbe\u5230\u4e0a\u9650" });
  const endpoint = endpointSummary(event);
  if (!endpoint) return res.status(400).json({ error: "\u53ea\u5141\u8bb8 HTTPS \u4f1a\u8bdd\u4fe1\u606f" });
  if (session.locked_origin && endpoint.baseUrl !== session.locked_origin) {
    return res.json({ ok: true, ignored: true, reason: "outside-locked-origin" });
  }
  const existingRows = db.prepare("SELECT safe_json FROM venue_discovery_events WHERE session_id=? ORDER BY id DESC LIMIT 80").all(session.id);
  const candidate = candidateScore(session, event, endpoint, existingRows);
  const safe = {
    endpoint,
    capturedAt: nowIso(),
    candidate,
    annotation: { selected: candidate.nameMatched, label: "", tags: [], note: "" },
  };
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
  const eventId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
  db.prepare("UPDATE venue_discovery_sessions SET updated_at=? WHERE id=?").run(now, session.id);
  res.json({ ok: true, accepted: true, count: count + 1, eventId, endpoint, candidate });
});

router.post("/venue-discovery/sessions/:id/lock-entry", (req, res) => {
  if (!req.deviceAuthenticated) return res.status(403).json({ error: "\u8bbe\u5907\u672a\u914d\u5bf9" });
  const session = activeSession(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: "\u53d1\u73b0\u4f1a\u8bdd\u4e0d\u5b58\u5728\u6216\u5df2\u7ed3\u675f" });
  if (session.locked_origin) return res.status(409).json({ error: "\u5165\u53e3\u5df2\u9501\u5b9a", lockedOrigin: session.locked_origin, lockedPath: session.locked_path });
  const eventId = Number(req.body?.eventId);
  const row = db.prepare("SELECT safe_json FROM venue_discovery_events WHERE id=? AND session_id=?").get(eventId, session.id);
  if (!row) return res.status(404).json({ error: "\u5019\u9009\u4f1a\u8bdd\u4fe1\u606f\u4e0d\u5b58\u5728" });
  let safe;
  try { safe = JSON.parse(row.safe_json); } catch { return res.status(500).json({ error: "\u4f1a\u8bdd\u4fe1\u606f\u635f\u574f" }); }
  const endpoint = safe.endpoint;
  if (!endpoint?.baseUrl || !endpoint?.path) return res.status(422).json({ error: "\u5019\u9009\u5185\u5bb9\u65e0\u6548" });
  const now = nowIso();
  db.prepare("UPDATE venue_discovery_sessions SET status='locked',locked_origin=?,locked_path=?,updated_at=? WHERE id=?")
    .run(endpoint.baseUrl, endpoint.path, now, session.id);
  res.json({ ok: true, scope: { origin: endpoint.baseUrl, entryPath: endpoint.path } });
});

router.post("/venue-discovery/sessions/:id/events/:eventId/annotation", (req, res) => {
  if (!req.deviceAuthenticated) return res.status(403).json({ error: "\u8bbe\u5907\u672a\u914d\u5bf9" });
  const session = activeSession(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: "\u53d1\u73b0\u4f1a\u8bdd\u4e0d\u5b58\u5728\u6216\u5df2\u7ed3\u675f" });
  const row = db.prepare("SELECT id,safe_json FROM venue_discovery_events WHERE id=? AND session_id=?").get(req.params.eventId, session.id);
  if (!row) return res.status(404).json({ error: "\u4f1a\u8bdd\u4fe1\u606f\u4e0d\u5b58\u5728" });
  let safe;
  try { safe = JSON.parse(row.safe_json); } catch { return res.status(500).json({ error: "\u4f1a\u8bdd\u4fe1\u606f\u635f\u574f" }); }
  const input = req.body || {};
  safe.annotation = {
    selected: input.selected !== false,
    label: String(input.label || "").trim().slice(0, 80),
    tags: Array.isArray(input.tags) ? input.tags.map((value) => String(value).trim().slice(0, 32)).filter(Boolean).slice(0, 12) : [],
    note: String(input.note || "").trim().slice(0, 240),
  };
  const now = nowIso();
  db.prepare("UPDATE venue_discovery_events SET safe_json=? WHERE id=?").run(JSON.stringify(safe), row.id);
  db.prepare("UPDATE venue_discovery_sessions SET updated_at=? WHERE id=?").run(now, session.id);
  res.json({ ok: true, item: safe });
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