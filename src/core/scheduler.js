import { listJobs, updateJob, archiveJob } from "./jobStore.js";
import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";
import { enqueueBooking, applyCooldown } from "./requestLimiter.js";
import { getRiskProfile, recordRiskEvent } from "./riskProfile.js";
import { db } from "./database.js";
import { notifyJobResult } from "./notifications.js";
import { finalizeAndRepeatGroup } from "./jobGroups.js";
import { creatorBalanceFallback, expireAwaitingPayments, fallbackEnabled, markAwaitingPayment, pollAwaitingPayments, requiresManualPayment } from "./paymentLifecycle.js";

const TICK_MS = 1000;
const LOOKAHEAD_MS = 60000;
const PREHEAT_MS = 15000;
export const readyCache = new Map();
const scheduled = new Set();
const lastMinuteCheck = new Map();
let lastHourlyCheck = 0;
let timer = null;

export function startScheduler() { if (timer) return; console.log(`[scheduler] started tick=${TICK_MS}ms`); timer = setInterval(tick, TICK_MS); tick(); }
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }

async function tick() {
  const now = Date.now();
  expireAwaitingPayments(now).catch((error) => console.warn("[payment-expire]", String(error?.message || error)));
  pollAwaitingPayments(now).catch((error) => console.warn("[payment-poll]", error.message));
  const jobs = listJobs();
  for (const job of jobs) {
    if (job.status !== "pending" || scheduled.has(job.id)) continue;
    const fireMs = job.fireAt ? new Date(job.fireAt).getTime() : 0;
    if (!job.fireAt || fireMs <= now) { scheduled.add(job.id); runGrab(job).catch((e) => console.error("[grab]", e)); }
    else if (fireMs - now <= LOOKAHEAD_MS) { scheduled.add(job.id); schedulePreciseFire(job, fireMs); }
  }
  if (now - lastHourlyCheck >= 3600000) { lastHourlyCheck = now; doReadyCheckAll("hourly"); }
  const soon = new Map();
  for (const job of jobs) { if (job.status === "pending" && job.fireAt) { const d = new Date(job.fireAt).getTime() - now; if (d > 0 && d <= 600000 && !soon.has(job.venueId)) soon.set(job.venueId, job.userId); } }
  for (const [venueId, userId] of soon) { const last = lastMinuteCheck.get(venueId) || 0; if (now - last >= 60000) { lastMinuteCheck.set(venueId, now); doReadyCheck(venueId, "pre-grab-1min", userId); } }
}

function schedulePreciseFire(job, fireMs) {
  const venue = getVenue(job.venueId);
  if (!venue) { updateJob(job.id, { status: "failed", result: { message: `unknown venue: ${job.venueId}` } }); scheduled.delete(job.id); return; }
  const credential = getCredential(job.venueId, job.userId);
  setTimeout(async () => { try { if (typeof venue.preheat === "function") await venue.preheat(credential); } catch (e) { console.warn("[preheat]", e.message); } }, Math.max(0, fireMs - PREHEAT_MS - Date.now()));
  setTimeout(() => runGrab(job, credential, venue).catch((e) => console.error("[grab]", e)), Math.max(0, fireMs - Date.now()));
  console.log(`[schedule] job=${job.id} fireAt=${new Date(fireMs).toISOString()}`);
}

async function runGrab(job, credentialArg, venueArg) {
  const venue = venueArg || getVenue(job.venueId);
  if (!venue) { updateJob(job.id, { status: "failed", result: { message: `unknown venue: ${job.venueId}` } }); scheduled.delete(job.id); return; }
  const credential = credentialArg || getCredential(job.venueId, job.userId);
  const adapterProfile = venue.riskProfile || {};
  // 限流/冷却 scope 统一为 店铺+凭证用户(与 enqueueBooking 的 limiterProfile 一致)
  const scopeKey = `${adapterProfile.scopeKey || job.venueId}:${job.userId}`;
  let profile = getRiskProfile(job.venueId, adapterProfile);
  const maxAttempts = Math.min(60, Math.max(Number(profile.booking.maxRetry || 5), Number(adapterProfile.booking?.maxRetry || 0), Number(job.target.ext?.maxRetry || 0)));
  const retryPolicy = venue.meta?.raw?.releaseRetry || {};
  const fastRetry = retryPolicy.fastRetry || {};
  const fastRetryIntervals = Array.isArray(fastRetry.intervalsMs) ? fastRetry.intervalsMs.map(Number).filter(Number.isFinite) : [];
  const releaseMaxAttempts = Math.max(1, Number(retryPolicy.maxAttempts || maxAttempts));
  let releasePending = false;
  let prebuilt = null;
  try { if (typeof venue.buildGrabRequest === "function") prebuilt = venue.buildGrabRequest(job.target, credential); }
  catch (e) { updateJob(job.id, { status: "failed", result: { message: e.message } }); scheduled.delete(job.id); return; }
  updateJob(job.id, { status: "running", result: { message: "dispatching", plannedAt: job.fireAt } });
  const startedMs = Date.now();
  let result = null;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let dispatchedMs = null;
      const releaseBaseInterval = Number(fastRetry.minIntervalMs);
      const hasCalibratedReleaseInterval = Number.isFinite(releaseBaseInterval) && releaseBaseInterval > 0;
      const fallbackReleaseInterval = fastRetryIntervals[Math.min(Math.max(attempt - 2, 0), Math.max(0, fastRetryIntervals.length - 1))] || Number(retryPolicy.defaultMinIntervalMs || 0);
      const releaseInterval = hasCalibratedReleaseInterval ? releaseBaseInterval : fallbackReleaseInterval;
      try {
        const useReleaseLimiter = releasePending || (attempt === 1 && !!job.fireAt && hasCalibratedReleaseInterval);
        // 限流按 店铺+凭证用户 分队列: 银豹风控是用户(凭证)级, 同凭证的主抢订与兜底必须共享冷却,
        // 不同凭证(B→A 余额兜底)保持并行, 避免兜底紧跟主抢订触发"操作太频繁"
        const limiterProfile = { ...adapterProfile, scopeKey: `${adapterProfile.scopeKey || job.venueId}:${job.userId}` };
        result = await enqueueBooking(job.venueId, limiterProfile, async () => {
          dispatchedMs = Date.now();
          const plannedMs = job.fireAt ? new Date(job.fireAt).getTime() : null;
          console.log(`[dispatch] job=${job.id} venue=${job.venueId} attempt=${attempt} planned=${job.fireAt || "immediate"} actual=${new Date(dispatchedMs).toISOString()} driftMs=${plannedMs == null ? "n/a" : dispatchedMs - plannedMs}`);
          return prebuilt && typeof venue.fireGrab === "function" ? venue.fireGrab(prebuilt) : venue.grab(job.target, credential);
        }, useReleaseLimiter ? { minIntervalMs: releaseInterval, jitterMs: Number(fastRetry.jitterMs || 0) } : undefined);
      } catch (e) { result = { success: false, message: String(e.message || e) }; }
      let classification = typeof venue.classifyGrabResult === "function" ? venue.classifyGrabResult(result) : classifyResult(result);
      const releaseElapsedMs = job.fireAt ? Math.max(0, Date.now() - new Date(job.fireAt).getTime()) : Number.POSITIVE_INFINITY;
      const releaseWindowMs = Number(retryPolicy.unavailableGraceMs || 0);
      const unavailableText = String(result?.message || "");
      if (classification === "terminal" && releaseWindowMs > 0 && releaseElapsedMs <= releaseWindowMs && /\u4e0d\u53ef\u7ea6|\u65e0\u6548\u65f6\u6bb5/.test(unavailableText)) classification = "release-pending";
      recordAttempt(job, attempt, dispatchedMs || Date.now(), classification, dispatchedMs ? Date.now() - dispatchedMs : 0, result?.message);
      profile = recordRiskEvent(job.venueId, classification === "success" ? "success" : classification === "rate-limited" ? "rate-limited" : "request", adapterProfile);
      if (classification === "success") break;
      if (classification === "release-pending") releasePending = true;
      if (!["not-released", "release-pending", "rate-limited", "transient"].includes(classification) || attempt >= maxAttempts || (classification === "release-pending" && attempt >= releaseMaxAttempts)) break;
      if (classification === "release-pending" && releaseElapsedMs >= releaseWindowMs) break;
      const delay = linearRetryDelay(profile, classification);
      if (classification === "rate-limited") applyCooldown(scopeKey, delay);
      const loggedDelay = classification === "release-pending" ? releaseInterval : delay;
      console.warn("[grab] job=" + job.id + " retry=" + (attempt + 1) + "/" + (classification === "release-pending" ? releaseMaxAttempts : maxAttempts) + " class=" + classification + " delayMs=" + loggedDelay + (classification === "release-pending" ? " fastRelease=true" : ""));
      // The serial limiter already enforces minIntervalMs plus jitter after every booking call.
      if (classification !== "release-pending") await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const elapsedMs = Date.now() - startedMs;
    if (requiresManualPayment(job, result)) { markAwaitingPayment(job, result, elapsedMs); return; }
    if (result?.success !== true && fallbackEnabled(job)) {
      // 余额支付失败(如授权方余额不足)时, 用创建任务者本人余额兜底
      const fallback = await creatorBalanceFallback(job, Date.now());
      if (fallback?.success === true) result = { ...fallback, message: `${result?.message || "抢订失败"}，已改用本人余额支付兜底成功` };
      else if (fallback) result = { ...result, message: `${result?.message || "抢订失败"}；本人余额兜底未成功: ${fallback.message}` };
    }
    const completed = updateJob(job.id, { status: result?.success ? "done" : "failed", result: { ...result, elapsedMs } });
    if (completed) { notifyJobResult(completed).catch((error) => console.warn("[notification]", error.message)); archiveJob(completed.id); finalizeAndRepeatGroup(completed.groupUid); }
  } catch (error) {
    const message = `调度异常: ${String(error?.message || error)}`;
    console.error(`[grab] job=${job.id} ${message}`);
    const completed = updateJob(job.id, { status: "failed", result: { success: false, message, elapsedMs: Date.now() - startedMs } });
    if (completed) { notifyJobResult(completed).catch((notifyError) => console.warn("[notification]", notifyError.message)); archiveJob(completed.id); finalizeAndRepeatGroup(completed.groupUid); }
  } finally { scheduled.delete(job.id); }
}

export function classifyResult(result) {
  if (result?.success) return "success";
  const text = JSON.stringify(result || {}).toLowerCase();
  if (text.includes("操作太频繁") || text.includes("操作频繁") || text.includes("too frequent") || text.includes("rate limit") || text.includes("429")) return "rate-limited";
  if (text.includes("尚未放场") || text.includes("还没开场") || text.includes("未开放") || text.includes("超过可预约日期") || text.includes("not released")) return "not-released";
  if (text.includes("timeout") || text.includes("aborted") || text.includes("econn") || text.includes("502") || text.includes("503")) return "transient";
  return "terminal";
}
export function linearRetryDelay(profile, classification) {
  const b = profile.booking || {};
  const base = (classification === "not-released" || classification === "release-pending") ? Number(b.notReleasedIntervalMs || b.minIntervalMs || 3000) : classification === "transient" ? Number(b.transientIntervalMs || b.minIntervalMs || 3000) : Number(b.cooldownMs || 10000);
  return base + Math.floor(Math.random() * (Number(b.jitterMs || 0) + 1));
}
function recordAttempt(job, attempt, dispatchedMs, classification, durationMs, message) {
  const plannedMs = job.fireAt ? new Date(job.fireAt).getTime() : null;
  const scopeKey = getVenue(job.venueId)?.riskProfile?.scopeKey || job.venueId;
  try { db.prepare("INSERT INTO job_attempts(job_id,attempt,planned_at,dispatched_at,drift_ms,scope_key,classification,duration_ms,message) VALUES(?,?,?,?,?,?,?,?,?)").run(job.id, attempt, job.fireAt || null, new Date(dispatchedMs).toISOString(), plannedMs == null ? null : dispatchedMs - plannedMs, scopeKey, classification, durationMs, String(message || "").slice(0, 500)); } catch (e) { console.warn("[audit]", e.message); }
}

export async function doReadyCheck(venueId, reason = "manual", userId = "legacy-owner") {
  const venue = getVenue(venueId); if (!venue) return { ok: false, detail: "unknown venue" };
  let result; try { result = await venue.ready(getCredential(venueId, userId)); } catch (e) { result = { ok: false, detail: String(e.message || e) }; }
  readyCache.set(`${userId}:${venueId}`, { at: new Date().toISOString(), reason, result }); readyCache.set(venueId, { at: new Date().toISOString(), reason, result });
  console.log(`[ready:${reason}] ${venueId} -> ${result.ok ? "OK" : "FAIL"} ${result.detail || ""}`); return result;
}
export async function doReadyCheckAll(reason) { const pairs = new Map(listJobs().map((j) => [`${j.userId}:${j.venueId}`, j])); for (const j of pairs.values()) await doReadyCheck(j.venueId, reason, j.userId); }