import { getRiskProfile } from "./riskProfile.js";
const queues = new Map();
const stateByVenue = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
function state(venueId) { if (!stateByVenue.has(venueId)) stateByVenue.set(venueId, { nextAllowedAt: 0, cooldownUntil: 0 }); return stateByVenue.get(venueId); }
export function enqueueBooking(venueId, adapterProfile, task) { const previous = queues.get(venueId) || Promise.resolve(); const current = previous.catch(() => {}).then(async () => { const profile = getRiskProfile(venueId, adapterProfile); const s = state(venueId); await sleep(Math.max(s.nextAllowedAt, s.cooldownUntil) - Date.now()); const result = await task(); const jitter = Math.floor(Math.random() * (Number(profile.booking.jitterMs) + 1)); s.nextAllowedAt = Date.now() + Number(profile.booking.minIntervalMs) + jitter; return result; }); queues.set(venueId, current.finally(() => { if (queues.get(venueId) === current) queues.delete(venueId); })); return current; }
export function applyCooldown(venueId, cooldownMs) { const s = state(venueId); s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + cooldownMs); }
export function resetLimiterState() { queues.clear(); stateByVenue.clear(); }
