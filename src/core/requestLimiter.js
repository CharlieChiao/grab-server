import { getRiskProfile } from "./riskProfile.js";
const queues = new Map(); // scopeKey -> { items: [], running: false }
const stateByVenue = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
function state(scopeKey) { if (!stateByVenue.has(scopeKey)) stateByVenue.set(scopeKey, { nextAllowedAt: 0, cooldownUntil: 0 }); return stateByVenue.get(scopeKey); }

// 下单限流队列: 同 scope(店铺+凭证用户)串行互斥。
// options.priority: 'high'(到点抢订任务) 插队到普通任务(捡漏等)之前 —— 开抢时刻的抢订
// 不被捡漏的在途请求与间隔拖延; 普通任务之间维持 FIFO。
export function enqueueBooking(venueId, adapterProfile, task, options = {}) {
  const scopeKey = adapterProfile.scopeKey || venueId;
  const q = queues.get(scopeKey) || { items: [], running: false };
  queues.set(scopeKey, q);
  return new Promise((resolve, reject) => {
    const item = { venueId, adapterProfile, task, options, resolve, reject, high: options.priority === "high" };
    if (item.high) {
      const idx = q.items.findIndex((x) => !x.high);
      if (idx >= 0) q.items.splice(idx, 0, item); else q.items.push(item);
    } else q.items.push(item);
    run(scopeKey);
  });
}
async function run(scopeKey) {
  const q = queues.get(scopeKey);
  if (!q || q.running) return;
  q.running = true;
  try {
    while (q.items.length) {
      const item = q.items.shift();
      const s = state(scopeKey);
      await sleep(Math.max(s.nextAllowedAt, s.cooldownUntil) - Date.now());
      try {
        const result = await item.task();
        const profile = getRiskProfile(item.venueId, item.adapterProfile);
        const minIntervalMs = Number.isFinite(Number(item.options.minIntervalMs)) ? Number(item.options.minIntervalMs) : Number(profile.booking.minIntervalMs);
        const jitterMs = Number.isFinite(Number(item.options.jitterMs)) ? Number(item.options.jitterMs) : Number(profile.booking.jitterMs);
        const jitter = Math.floor(Math.random() * (Math.max(0, jitterMs) + 1));
        s.nextAllowedAt = Date.now() + Math.max(0, minIntervalMs) + jitter;
        item.resolve(result);
      } catch (e) { item.reject(e); }
    }
  } finally {
    q.running = false;
    if (!q.items.length) queues.delete(scopeKey);
  }
}
export function applyCooldown(scopeKey, cooldownMs) { const s = state(scopeKey); s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + cooldownMs); }
export function resetLimiterState() { queues.clear(); stateByVenue.clear(); }
