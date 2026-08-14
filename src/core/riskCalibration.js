import { db } from "./database.js";
import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";
import { getRiskProfile, saveRiskProfile } from "./riskProfile.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function number(value, fallback, min = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export async function calibrateVenue(venueId, userId, options = {}) {
  const venue = getVenue(venueId);
  if (!venue || typeof venue.riskProbe !== "function") return { ok: false, skipped: true, reason: "riskProbe unsupported" };
  const rawPolicy = venue.meta?.raw?.releaseRetry || {};
  const configured = { ...(venue.riskProfile?.calibration || {}), ...(rawPolicy.calibration || {}) };
  const blackoutMinutes = number(configured.blackoutMinutes, 30);
  const cutoff = new Date(Date.now() + blackoutMinutes * 60000).toISOString();
  if (db.prepare("SELECT 1 FROM jobs WHERE venue_id=? AND status='pending' AND fire_at IS NOT NULL AND fire_at<=? LIMIT 1").get(venueId, cutoff)) return { ok: false, skipped: true, reason: "booking blackout window" };
  const credential = getCredential(venueId, userId);
  if (!credential) return { ok: false, skipped: true, reason: "credential missing" };

  const profile = getRiskProfile(venueId, venue.riskProfile || {});
  const stepMs = number(options.decreaseStepMs, number(configured.decreaseStepMs, 250), 1);
  const precisionMs = number(options.precisionMs, number(configured.precisionMs, 50), 1);
  const floorMs = number(options.minProbeIntervalMs, number(configured.minProbeIntervalMs, 250), 1);
  const cooldownMs = number(options.cooldownMs, number(configured.cooldownMs, profile.booking.cooldownMs || 10000));
  const maxProbes = Math.max(3, Math.min(40, number(options.maxProbes, number(configured.maxProbes, 24), 3)));
  let safeMs = Math.max(floorMs, number(options.initialIntervalMs, number(configured.initialIntervalMs, profile.booking.minIntervalMs || 3000), 1));
  let unsafeMs = null;
  const observations = [];

  async function probe(intervalMs) {
    if (observations.length) await sleep(intervalMs);
    const result = await venue.riskProbe(credential, { calibration: true, intervalMs });
    observations.push({ at: new Date().toISOString(), intervalMs, ...result });
    if (result.rateLimited) await sleep(cooldownMs);
    return result;
  }

  // Establish a known-safe point. If a previously stored value became unsafe, walk upward first.
  let baseline = await probe(safeMs);
  while (baseline.rateLimited && observations.length < maxProbes) {
    unsafeMs = safeMs;
    safeMs += stepMs;
    baseline = await probe(safeMs);
  }
  if (baseline.rateLimited) return { ok: false, skipped: true, reason: "no safe interval found", observations };

  // Descend in fixed steps until the first rate-limited point brackets the threshold.
  for (let candidate = safeMs - stepMs; candidate >= floorMs && observations.length < maxProbes; candidate -= stepMs) {
    const result = await probe(candidate);
    if (result.rateLimited) { unsafeMs = candidate; break; }
    safeMs = candidate;
  }

  // If we found a failing point, bisect to a final safe value within the requested precision.
  while (unsafeMs != null && safeMs - unsafeMs > precisionMs && observations.length < maxProbes) {
    const candidate = Math.ceil((safeMs + unsafeMs) / 2);
    const result = await probe(candidate);
    if (result.rateLimited) unsafeMs = candidate;
    else safeMs = candidate;
  }

  profile.mode = "serial-threshold-calibrated";
  profile.booking.minIntervalMs = safeMs;
  profile.booking.jitterMs = number(rawPolicy.jitterMs, profile.booking.jitterMs || 0);
  profile.calibration = {
    updatedAt: new Date().toISOString(),
    endpoint: observations[0]?.endpoint || null,
    method: "step-down-bisect",
    precisionMs,
    safeIntervalMs: safeMs,
    firstRateLimitedIntervalMs: unsafeMs,
    observations,
  };
  saveRiskProfile(venueId, profile);
  return { ok: true, venueId, effectiveMinIntervalMs: safeMs, thresholdBracketMs: unsafeMs == null ? null : { safe: safeMs, rateLimited: unsafeMs }, observations };
}

let timer = null, lastDailyKey = null;
export function startRiskCalibrationScheduler() {
  // Booking-sensitive calibration is intentionally manual only.
  if (process.env.ENABLE_BACKGROUND_RISK_CALIBRATION !== "true") return;
  if (timer) return;
  timer = setInterval(async () => {
    const bj = new Date(Date.now() + 28800000), key = bj.toISOString().slice(0, 10);
    if (bj.getUTCHours() !== 3 || bj.getUTCMinutes() < 30 || lastDailyKey === key) return;
    lastDailyKey = key;
    for (const row of db.prepare("SELECT user_id,venue_id FROM credentials").all()) { try { await calibrateVenue(row.venue_id, row.user_id); } catch (e) { console.warn("[risk-calibration]", e.message); } }
  }, 60000);
}
