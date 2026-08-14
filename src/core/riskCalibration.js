import { db } from "./database.js";
import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";
import { getRiskProfile, saveRiskProfile } from "./riskProfile.js";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function calibrateVenue(venueId, userId, options = {}) {
  const venue = getVenue(venueId);
  if (!venue || typeof venue.riskProbe !== "function") return { ok: false, skipped: true, reason: "riskProbe unsupported" };
  const blackoutMinutes = Number(venue.riskProfile?.calibration?.blackoutMinutes || 30);
  const cutoff = new Date(Date.now() + blackoutMinutes * 60000).toISOString();
  if (db.prepare("SELECT 1 FROM jobs WHERE venue_id=? AND status='pending' AND fire_at IS NOT NULL AND fire_at<=? LIMIT 1").get(venueId, cutoff)) return { ok: false, skipped: true, reason: "booking blackout window" };
  const credential = getCredential(venueId, userId);
  if (!credential) return { ok: false, skipped: true, reason: "credential missing" };
  const profile = getRiskProfile(venueId, venue.riskProfile || {});
  const config = venue.riskProfile?.calibration || {};
  const samples = Math.max(3, Math.min(12, Number(options.samples || config.samples || 6)));
  let candidate = Number(profile.booking.minIntervalMs || 3000), consecutiveSafe = 0;
  const observations = [];
  for (let index = 0; index < samples; index++) {
    if (index) await sleep(candidate);
    const result = await venue.riskProbe(credential, { calibration: true });
    observations.push({ at: new Date().toISOString(), intervalMs: candidate, ...result });
    if (result.rateLimited) { candidate += Number(profile.booking.increaseStepMs || 500); consecutiveSafe = 0; await sleep(Number(profile.booking.cooldownMs || 10000)); }
    else if (result.ok && ++consecutiveSafe >= 3) { candidate = Math.max(Number(config.minIntervalMs || 1000), candidate - Number(config.decreaseStepMs || 250)); consecutiveSafe = 0; }
  }
  profile.mode = "serial-linear-calibrated";
  profile.booking.minIntervalMs = candidate;
  profile.calibration = { updatedAt: new Date().toISOString(), endpoint: observations[0]?.endpoint || null, observations };
  saveRiskProfile(venueId, profile);
  return { ok: true, venueId, effectiveMinIntervalMs: candidate, observations };
}
let timer = null, lastDailyKey = null;
export function startRiskCalibrationScheduler() {
  if (timer) return;
  timer = setInterval(async () => {
    const bj = new Date(Date.now() + 28800000), key = bj.toISOString().slice(0, 10);
    if (bj.getUTCHours() !== 3 || bj.getUTCMinutes() < 30 || lastDailyKey === key) return;
    lastDailyKey = key;
    for (const row of db.prepare("SELECT user_id,venue_id FROM credentials").all()) { try { await calibrateVenue(row.venue_id, row.user_id); } catch (e) { console.warn("[risk-calibration]", e.message); } }
  }, 60000);
}