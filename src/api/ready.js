import express from "express";
import { listVenues, getVenue } from "../core/venueRegistry.js";
import { doReadyCheck, readyCache } from "../core/scheduler.js";
import { getCredential, setCredential } from "../core/credentialStore.js";
import { db, nowIso } from "../core/database.js";
import { calibrateVenue } from "../core/riskCalibration.js";

const router = express.Router();

router.post("/account/claim-legacy", (req, res) => {
  const userId = req.user.id;
  const legacy = db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE user_id=?").get("legacy-owner").n;
  if (!legacy) return res.json({ ok: true, claimed: false });
  if (db.prepare("SELECT 1 FROM credentials WHERE user_id=? LIMIT 1").get(userId)) return res.json({ ok: true, claimed: false });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE credentials SET user_id=? WHERE user_id=?").run(userId, "legacy-owner");
    db.prepare("UPDATE jobs SET user_id=? WHERE user_id=?").run(userId, "legacy-owner");
    db.prepare("DELETE FROM users WHERE id=?").run("legacy-owner");
    const now = nowIso();
    db.prepare("INSERT OR IGNORE INTO users(id, openid_hash, created_at, last_seen_at) VALUES(?, ?, ?, ?)").run(userId, userId, now, now);
    db.exec("COMMIT");
    res.json({ ok: true, claimed: true });
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    console.error("[claim-legacy]", error);
    res.status(500).json({ error: "旧数据认领失败" });
  }
});

router.post("/devices/pair", (req, res) => {
  const raw = req.body?.payload;
  let payload;
  try { payload = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return res.status(400).json({ error: "配对二维码无效" }); }
  if (!payload || payload.type !== "court_capture_pair" || !payload.deviceId || !payload.publicKey) return res.status(400).json({ error: "配对二维码格式无效" });
  const now = nowIso();
  const sql = "INSERT INTO devices(device_id, user_id, public_key, device_name, paired_at, last_seen_at, revoked) VALUES(?, ?, ?, ?, ?, ?, 0) ON CONFLICT(device_id) DO UPDATE SET user_id=excluded.user_id, public_key=excluded.public_key, device_name=excluded.device_name, last_seen_at=excluded.last_seen_at, revoked=0";
  db.prepare(sql).run(payload.deviceId, req.user.id, payload.publicKey, payload.deviceName || "Court Capture", now, now);
  res.json({ ok: true, message: "电脑配对成功", deviceId: payload.deviceId });
});
router.post("/venues/:id/discover-capture", (req, res) => {
  const venue = getVenue(req.params.id);
  if (!venue) return res.status(404).json({ error: "unknown venue" });
  if (!credentialUpdateAllowed(req)) return res.status(401).json({ error: "credential update token invalid" });
  if (typeof venue.discoverCapture !== "function") return res.status(501).json({ error: "venue discovery is not supported" });
  const submittedCourts = Array.isArray(req.body?.courts) ? req.body.courts : null;
  const discovered = submittedCourts ? { courts: submittedCourts.map((court) => ({ providerCourtId: String(court.providerCourtId || ""), name: String(court.name || "").slice(0, 100) })).filter((court) => /^\\d{6,}$/.test(court.providerCourtId)) } : venue.discoverCapture(req.body || {});
  const now = nowIso();
  const findExisting = db.prepare("SELECT court_id FROM venue_catalog WHERE venue_id=? AND provider_id=?");
  const insert = db.prepare("INSERT INTO venue_catalog(venue_id,court_id,provider_id,name,type,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(venue_id,provider_id) DO UPDATE SET name=excluded.name,type=excluded.type,updated_at=excluded.updated_at");
  for (const court of discovered.courts || []) {
    const configured = (venue.meta.courts || []).find((item) => String(item.uid || item.providerCourtId) === String(court.providerCourtId));
    const existing = findExisting.get(req.params.id, String(court.providerCourtId));
    const courtId = configured?.id || existing?.court_id || `provider-${court.providerCourtId}`;
    insert.run(req.params.id, courtId, String(court.providerCourtId), court.name || courtId, court.type || configured?.type || null, now);
  }
  res.json({ ok: true, discovered: discovered.courts || [] });
});
router.get("/venues", (req, res) => res.json({ ok: true, venues: listVenues() }));
router.get("/venues/:id/reference-price", async (req, res) => {
  const venue = getVenue(req.params.id);
  const date = String(req.query.date || "").trim();
  const courtUids = String(req.query.courtUids || "").split(",").map((v) => v.trim()).filter(Boolean);
  const times = String(req.query.times || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!venue) return res.status(404).json({ error: "not found" });
  if (!date || !courtUids.length || !times.length) return res.status(400).json({ error: "date, courtUids and times are required" });
  if (typeof venue.listSlots !== "function") return res.status(501).json({ error: "venue slot pricing is not supported" });
  const previousWeek = (value) => {
    const [year, month, day] = value.split("-").map(Number);
    const d = new Date(Date.UTC(year, month - 1, day - 7));
    return d.toISOString().slice(0, 10);
  };
  const summarize = (slots, sourceDate) => {
    const map = new Map((slots || []).map((slot) => [`${slot.uid}|${String(slot.begin || "").slice(11, 16)}`, Number(slot.cost) || 0]));
    const prices = [];
    for (const uid of courtUids) for (const time of times) prices.push(map.get(`${uid}|${time}`) || 0);
    const selectedCourtReleased = (slots || []).some((slot) => courtUids.includes(String(slot.uid)));
    return { sourceDate, released: (slots || []).length > 0, selectedCourtReleased, complete: prices.length > 0 && prices.every((price) => price > 0), total: prices.reduce((sum, price) => sum + price, 0) };
  };
  try {
    const cred = getCredential(req.params.id, req.user.id);
    const todaySlots = await venue.listSlots({ date }, cred);
    const today = summarize(todaySlots, date);
    if (today.selectedCourtReleased) return res.json({ ok: true, ...today, fallback: false });
    const historicDate = previousWeek(date);
    const historic = summarize(await venue.listSlots({ date: historicDate }, cred), historicDate);
    res.json({ ok: true, ...historic, fallback: true });
  } catch (error) {
    res.status(502).json({ error: "查询参考价格失败", detail: String(error.message || error) });
  }
});
router.get("/venues/:id/slots", async (req, res) => {
  const venue = getVenue(req.params.id);
  const date = String(req.query.date || "").trim();
  if (!venue) return res.status(404).json({ error: "not found" });
  if (!date) return res.status(400).json({ error: "date is required" });
  if (typeof venue.listSlots !== "function") return res.status(501).json({ error: "venue slot pricing is not supported" });
  try {
    const slots = await venue.listSlots({ date }, getCredential(req.params.id, req.user.id));
    res.json({ ok: true, venueId: req.params.id, date, released: slots.length > 0, slots });
  } catch (error) {
    res.status(502).json({ error: "查询场地价格失败", detail: String(error.message || error) });
  }
});router.get("/venues/:id", (req, res) => {
  const venue = getVenue(req.params.id);
  if (!venue) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, meta: venue.meta });
});
router.post("/risk/:venueId/calibrate", async (req, res) => {
  try { res.json(await calibrateVenue(req.params.venueId, req.user.id, req.body || {})); }
  catch (error) { res.status(500).json({ error: "risk calibration failed", detail: String(error.message || error) }); }
});
router.get("/ready/:venueId", async (req, res) => {
  const venue = getVenue(req.params.venueId);
  if (!venue) return res.status(404).json({ error: "unknown venue" });
  const result = await doReadyCheck(req.params.venueId, "api", req.user.id);
  res.json({ ...result, ok: result.ok === true, venueId: req.params.venueId });
});
router.get("/ready/:venueId/cache", (req, res) => res.json({ ok: true, cached: readyCache.get(req.params.venueId) || null }));

function extractVisitorId(input) {
  const text = String(input || "").trim();
  const match = text.match(/PSPLVISITORID\s*[:=]\s*["']?([A-Za-z0-9._:/+=-]{16,})/i);
  const value = match ? match[1] : text;
  return /^[A-Za-z0-9._:/+=-]{16,}$/.test(value) ? value : null;
}
function credentialUpdateAllowed(req) {
  const expected = process.env.CREDENTIAL_UPDATE_TOKEN;
  return !!expected && req.get("x-credential-update-token") === expected;
}
router.post("/credentials/:venueId/ingest", async (req, res) => {
  const venue = getVenue(req.params.venueId);
  if (!venue) return res.status(404).json({ error: "unknown venue" });
  if (!credentialUpdateAllowed(req)) return res.status(401).json({ error: "credential update token invalid" });
  const input = req.body?.text || req.body?.PSPLVISITORID || req.body?.value;
  const visitorId = extractVisitorId(input);
  if (!visitorId) return res.status(400).json({ error: "valid PSPLVISITORID not found" });
  setCredential(req.params.venueId, { PSPLVISITORID: visitorId }, req.user.id);
  let ready = null;
  try { ready = await doReadyCheck(req.params.venueId, "credential-ingest", req.user.id); } catch {}
  res.json({ ok: true, saved: true, ready: ready ? !!ready.ok : null });
});
router.put("/credentials/:venueId", (req, res) => {
  const venue = getVenue(req.params.venueId);
  if (!venue) return res.status(404).json({ error: "unknown venue" });
  setCredential(req.params.venueId, req.body || {}, req.user.id);
  res.json({ ok: true, saved: true });
});
router.get("/credentials/:venueId", (req, res) => {
  const credential = getCredential(req.params.venueId, req.user.id);
  res.json({ ok: true, configured: !!credential, keys: credential ? Object.keys(credential) : [] });
});
export default router;

