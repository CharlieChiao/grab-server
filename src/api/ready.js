/**
 * ready 妫€娴?& 鐞冨満淇℃伅 API
 *  GET  /api/venues                  鍒楀嚭鎵€鏈夌悆鍦?灞曠ず淇℃伅)
 *  GET  /api/venues/:id              鍗曚釜鐞冨満閰嶇疆
 *  GET  /api/ready/:venueId          瀹炴椂 ready 妫€娴?picklepop=PSPLVISITORID鏈夋晥鎬?
 *  GET  /api/ready/:venueId/cache    鏈€杩戜竴娆″績璺虫娴嬬殑缂撳瓨缁撴灉
 *  PUT  /api/credentials/:venueId    鏇存柊鏌愮悆鍦哄嚟璇?濡傛洿鏂?PSPLVISITORID)
 */
import express from "express";
import { listVenues, getVenue } from "../core/venueRegistry.js";
import { doReadyCheck, readyCache } from "../core/scheduler.js";
import { getCredential, setCredential } from "../core/credentialStore.js";

const router = express.Router();

router.get("/venues", (req, res) => {
  res.json({ ok: true, venues: listVenues() });
});

router.get("/venues/:id", (req, res) => {
  const v = getVenue(req.params.id);
  if (!v) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, meta: v.meta });
});

// 瀹炴椂 ready 妫€娴?
router.get("/ready/:venueId", async (req, res) => {
  const v = getVenue(req.params.venueId);
  if (!v) return res.status(404).json({ error: "鏈煡鐞冨満" });
  const result = await doReadyCheck(req.params.venueId, "api");
  res.json({ ok: true, venueId: req.params.venueId, ...result });
});

// 缂撳瓨鐨勫績璺崇粨鏋?
router.get("/ready/:venueId/cache", (req, res) => {
  const c = readyCache.get(req.params.venueId);
  if (!c) return res.json({ ok: true, cached: null });
  res.json({ ok: true, cached: c });
});

// 鏇存柊鍑瘉(澶辨晥鍚庢洿鏂?PSPLVISITORID 鐢?
function extractVisitorId(input) {
  const text = String(input || "").trim();
  const match = text.match(/(?:PSPLVISITORIDs*[:=]s*["']?)([A-Za-z0-9._:-]{16,})/i);
  const value = match ? match[1] : text;
  if (!/^[A-Za-z0-9._:-]{16,}$/.test(value)) return null;
  return value;
}

function credentialUpdateAllowed(req) {
  const expected = process.env.CREDENTIAL_UPDATE_TOKEN;
  return !expected || req.get("x-credential-update-token") === expected;
}

router.post("/credentials/:venueId/ingest", async (req, res) => {
  const v = getVenue(req.params.venueId);
  if (!v) return res.status(404).json({ error: "未知球场" });
  if (!credentialUpdateAllowed(req)) return res.status(401).json({ error: "凭证更新令牌无效" });

  const input = req.body && (req.body.text || req.body.PSPLVISITORID || req.body.value);
  const visitorId = extractVisitorId(input);
  if (!visitorId) return res.status(400).json({ error: "未找到有效的 PSPLVISITORID" });

  setCredential(req.params.venueId, { PSPLVISITORID: visitorId });
  let ready = null;
  try { ready = await doReadyCheck(req.params.venueId, "credential-ingest"); } catch {}
  res.json({ ok: true, saved: true, configured: true, ready: ready ? !!ready.ok : null });
});
router.put("/credentials/:venueId", (req, res) => {
  const v = getVenue(req.params.venueId);
  if (!v) return res.status(404).json({ error: "鏈煡鐞冨満" });
  const cred = req.body || {};
  setCredential(req.params.venueId, cred);
  res.json({ ok: true, saved: true });
});

router.get("/credentials/:venueId", (req, res) => {
  const cred = getCredential(req.params.venueId);
  // 鑴辨晱: 鍙繑鍥炴槸鍚﹂厤缃?
  res.json({ ok: true, configured: !!cred, keys: cred ? Object.keys(cred) : [] });
});

export default router;


