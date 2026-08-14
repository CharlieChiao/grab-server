import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "..", "config", "risk-profiles.json");
export const DEFAULT_RISK_PROFILE = Object.freeze({ version: 1, mode: "serial-exponential-backoff", booking: { minIntervalMs: 3000, jitterMs: 800, cooldownMs: 10000, maxRetry: 5, backoff: [3000, 6000, 12000, 20000] }, stats: { requests: 0, successes: 0, rateLimited: 0, lastRateLimitedAt: null } });
const clone = (value) => JSON.parse(JSON.stringify(value));
function ensure() { if (!fs.existsSync(path.dirname(FILE))) fs.mkdirSync(path.dirname(FILE), { recursive: true }); if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "{}", "utf8"); }
function readAll() { ensure(); try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } }
function writeAll(value) { ensure(); const tmp = `${FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8"); fs.renameSync(tmp, FILE); }
export function getRiskProfile(venueId, adapterProfile = {}) { const all = readAll(); const saved = all[venueId] || {}; const result = clone(DEFAULT_RISK_PROFILE); result.booking = { ...result.booking, ...(adapterProfile.booking || {}), ...(saved.booking || {}) }; result.stats = { ...result.stats, ...(saved.stats || {}) }; result.mode = saved.mode || adapterProfile.mode || result.mode; return result; }
export function recordRiskEvent(venueId, event, adapterProfile = {}) { const all = readAll(); const profile = getRiskProfile(venueId, adapterProfile); profile.stats.requests += 1; if (event === "success") profile.stats.successes += 1; if (event === "rate-limited") { profile.stats.rateLimited += 1; profile.stats.lastRateLimitedAt = new Date().toISOString(); profile.booking.minIntervalMs = Math.min(30000, Number(profile.booking.minIntervalMs || 3000) + Number(profile.booking.increaseStepMs || 500)); profile.booking.cooldownMs = Math.min(120000, Number(profile.booking.cooldownMs || 10000) + Number(profile.booking.cooldownStepMs || 5000)); profile.booking.jitterMs = Math.min(5000, Math.max(Number(profile.booking.jitterMs || 0), 250)); } all[venueId] = profile; writeAll(all); return profile; }
export function riskProfilePath() { return FILE; }

export function saveRiskProfile(venueId, profile) {
  const all = readAll();
  all[venueId] = profile;
  writeAll(all);
  return profile;
}