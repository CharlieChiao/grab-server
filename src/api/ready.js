import express from "express";
import { listVenues, getVenue } from "../core/venueRegistry.js";
import { doReadyCheck, readyCache } from "../core/scheduler.js";
import { getCredential, setCredential } from "../core/credentialStore.js";
import { db, nowIso } from "../core/database.js";

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

router.get("/venues", (req, res) => res.json({ ok: true, venues: listVenues() }));
router.get("/venues/:id", (req, res) => {
  const venue = getVenue(req.params.id);
  if (!venue) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, meta: venue.meta });
});
router.get("/ready/:venueId", async (req, res) => {
  const venue = getVenue(req.params.venueId);
  if (!venue) return res.status(404).json({ error: "unknown venue" });
  const result = await doReadyCheck(req.params.venueId, "api", req.user.id);
  res.json({ ok: true, venueId: req.params.venueId, ...result });
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
