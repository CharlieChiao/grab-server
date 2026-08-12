/**
 * ready 检测 & 球场信息 API
 *  GET  /api/venues                  列出所有球场(展示信息)
 *  GET  /api/venues/:id              单个球场配置
 *  GET  /api/ready/:venueId          实时 ready 检测(picklepop=PSPLVISITORID有效性)
 *  GET  /api/ready/:venueId/cache    最近一次心跳检测的缓存结果
 *  PUT  /api/credentials/:venueId    更新某球场凭证(如更新 PSPLVISITORID)
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

// 实时 ready 检测
router.get("/ready/:venueId", async (req, res) => {
  const v = getVenue(req.params.venueId);
  if (!v) return res.status(404).json({ error: "未知球场" });
  const result = await doReadyCheck(req.params.venueId, "api");
  res.json({ ok: true, venueId: req.params.venueId, ...result });
});

// 缓存的心跳结果
router.get("/ready/:venueId/cache", (req, res) => {
  const c = readyCache.get(req.params.venueId);
  if (!c) return res.json({ ok: true, cached: null });
  res.json({ ok: true, cached: c });
});

// 更新凭证(失效后更新 PSPLVISITORID 用)
router.put("/credentials/:venueId", (req, res) => {
  const v = getVenue(req.params.venueId);
  if (!v) return res.status(404).json({ error: "未知球场" });
  const cred = req.body || {};
  setCredential(req.params.venueId, cred);
  res.json({ ok: true, saved: true });
});

router.get("/credentials/:venueId", (req, res) => {
  const cred = getCredential(req.params.venueId);
  // 脱敏: 只返回是否配置
  res.json({ ok: true, configured: !!cred, keys: cred ? Object.keys(cred) : [] });
});

export default router;
