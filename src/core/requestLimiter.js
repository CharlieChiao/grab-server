import { getRiskProfile } from "./riskProfile.js";
const queues = new Map();
const stateByVenue = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
function state(venueId) { if (!stateByVenue.has(venueId)) stateByVenue.set(venueId, { nextAllowedAt: 0, cooldownUntil: 0 }); return stateByVenue.get(venueId); }
export function enqueueBooking(venueId, adapterProfile, task, options = {}) {
  const scopeKey = adapterProfile.scopeKey || venueId;
  const previous = queues.get(scopeKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const profile = getRiskProfile(venueId, adapterProfile);
    const s = state(scopeKey);
    await sleep(Math.max(s.nextAllowedAt, s.cooldownUntil) - Date.now());
    const result = await task();
    const minIntervalMs = Number.isFinite(Number(options.minIntervalMs)) ? Number(options.minIntervalMs) : Number(profile.booking.minIntervalMs);
    const jitterMs = Number.isFinite(Number(options.jitterMs)) ? Number(options.jitterMs) : Number(profile.booking.jitterMs);
    const jitter = Math.floor(Math.random() * (Math.max(0, jitterMs) + 1));
    s.nextAllowedAt = Date.now() + Math.max(0, minIntervalMs) + jitter;
    return result;
  });
  queues.set(scopeKey, current.finally(() => { if (queues.get(scopeKey) === current) queues.delete(scopeKey); }));
  return current;
}
export function applyCooldown(scopeKey, cooldownMs) { const s = state(scopeKey); s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + cooldownMs); }
export function resetLimiterState() { queues.clear(); stateByVenue.clear(); }
