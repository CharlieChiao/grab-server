import { listJobs, updateJob, archiveJob } from "./jobStore.js";
import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";
import { enqueueBooking, applyCooldown } from "./requestLimiter.js";
import { getRiskProfile, recordRiskEvent } from "./riskProfile.js";
import { db } from "./database.js";
import { notifyJobResult } from "./notifications.js";
import { finalizeAndRepeatGroup, stopPendingSiblingsAfterAnySuccess } from "./jobGroups.js";
import { creatorBalanceFallback, expireAwaitingPayments, fallbackEnabled, markAwaitingPayment, pollAwaitingPayments, requiresManualPayment, targetSlotsAvailable } from "./paymentLifecycle.js";

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

export function unavailableReasonFromSlots(target, slots) {
  const wanted = Array.isArray(target?.courts) && target.courts.length
    ? target.courts.map((c) => ({ uid: c.courtUid, court: c.court, time: c.time || target.time }))
    : [{ uid: target?.courtUid, court: target?.court, time: target?.time }];
  const reasons = [];
  for (const slot of slots || []) {
    for (const w of wanted) {
      const courtMatch = w.uid ? String(slot.uid) === String(w.uid) : String(slot.court || "") === String(w.court || "");
      const timeMatch = String(slot.begin || "").slice(11, 16) === String(w.time || "").slice(0, 5);
      if (courtMatch && timeMatch && !slot.canAppoint) {
        const match = /(\d{2}:\d{2})-\d{2}:\d{2}场次(.+)$/.exec(String(slot.message || ""));
        const text = match ? `${match[1]}${match[2]}` : String(slot.message || "不可约");
        if (!reasons.includes(text)) reasons.push(text);
      }
    }
  }
  return reasons.length ? reasons.join("、") : null;
}

// 下单报"不可约"时回查 listSlots, 把银豹的细分原因(已被预约/已被锁场/已被排课)附加到失败消息
export async function refineUnavailableReason(venue, job, credential, message) {
  if (!/不可约|不可预约/.test(String(message || ""))) return null;
  if (typeof venue?.listSlots !== "function") return null;
  try {
    const slots = await venue.listSlots({ date: job.target?.date }, credential);
    return unavailableReasonFromSlots(job.target, slots);
  } catch {
    return null;
  }
}

// 放场等待(watch 模式): 首发下单报"未放场"后, 改用随机短间隔轮询 listSlots 的 canAppoint(模拟人刷新)。
// 查询接口无用户级风控(校准实测 250ms 间隔安全), 且不经过 enqueueBooking 下单限流队列 ——
// 因此不占用/不阻塞任何下单(包括突然插进来的兜底任务); 检测到可约后回到 runGrab 循环,
// 下单请求照常走限流队列按 店铺+凭证 排队, 与兜底/其他任务正确互斥。
async function watchSlotRelease(venue, job, credential, cfg) {
  const intervalMs = Math.max(150, Number(cfg.watchIntervalMs) || 500);
  const jitterMs = Math.max(0, Number(cfg.watchJitterMs) || 0);
  const timeoutMs = Math.max(10_000, Number(cfg.watchTimeoutMs) || 180_000);
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;
  let polls = 0;
  console.log(`[watch] job=${job.id} start interval=${intervalMs}±${jitterMs}ms timeout=${timeoutMs}ms`);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs + Math.floor(Math.random() * (jitterMs + 1))));
    if (Date.now() >= deadline) break;
    try {
      const slots = await venue.listSlots({ date: job.target?.date }, credential);
      consecutiveErrors = 0;
      polls++;
      if (targetSlotsAvailable(job.target, slots)) {
        console.log(`[watch] job=${job.id} released after ${polls} polls (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s), booking now`);
        return true;
      }
    } catch (error) {
      if (++consecutiveErrors >= 10) { console.warn(`[watch] job=${job.id} aborted after ${consecutiveErrors} consecutive errors: ${String(error?.message || error)}`); return false; }
    }
  }
  console.warn(`[watch] job=${job.id} timeout after ${polls} polls, slot never released`);
  return false;
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
  try {
    // 支付准备契约: 下单前异步注入支付所需字段(次卡 venueTimeCardUid 等), 未实现的适配器原样透传
    const preparedTarget = typeof venue.prepareTarget === "function" ? await venue.prepareTarget(job.target, credential) : job.target;
    if (typeof venue.buildGrabRequest === "function") prebuilt = venue.buildGrabRequest(preparedTarget, credential);
  }
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
        }, { priority: "high", ...(useReleaseLimiter ? { minIntervalMs: releaseInterval, jitterMs: Number(fastRetry.jitterMs || 0) } : {}) });
      } catch (e) { result = { success: false, message: String(e.message || e) }; }
      let classification = typeof venue.classifyGrabResult === "function" ? venue.classifyGrabResult(result) : classifyResult(result);
      const releaseElapsedMs = job.fireAt ? Math.max(0, Date.now() - new Date(job.fireAt).getTime()) : Number.POSITIVE_INFINITY;
      const releaseWindowMs = Number(retryPolicy.unavailableGraceMs || 0);
      const unavailableText = String(result?.message || "");
      if (classification === "terminal" && releaseWindowMs > 0 && releaseElapsedMs <= releaseWindowMs && /不可约|无效时段/.test(unavailableText)) {
        // 放场宽限内的"不可约"先回查场次细分: 真被占(已被预约/排课/锁场)保持终态立即放弃全部重试, 只有疑似未放出才降级继续等
        const reason = await refineUnavailableReason(venue, job, credential, unavailableText);
        if (reason && /已被预约|已被排课|已被锁场/.test(reason)) {
          result = { ...result, message: `${unavailableText}（${reason}）` };
          classification = "terminal";
          console.log(`[grab] job=${job.id} slot occupied (${reason}), abandoning remaining attempts`);
        } else {
          classification = "release-pending";
        }
      }
      recordAttempt(job, attempt, dispatchedMs || Date.now(), classification, dispatchedMs ? Date.now() - dispatchedMs : 0, result?.message);
      profile = recordRiskEvent(job.venueId, classification === "success" ? "success" : classification === "rate-limited" ? "rate-limited" : "request", adapterProfile);
      if (classification === "success") break;
      if (classification === "release-pending") releasePending = true;
      // 未放场: 转 canAppoint 短轮询等待放场, 不再消耗下单 attempts, 不占下单限流队列(不阻塞兜底任务)
      const watchCfg = retryPolicy.watchSlotRelease === true ? retryPolicy : null;
      if (classification === "release-pending" && watchCfg && typeof venue.listSlots === "function") {
        const released = await watchSlotRelease(venue, job, credential, watchCfg);
        if (!released) break; // 超时/连续错误: 按最终失败走细分流程
        continue; // 目标场次已可约: attempt++ 立即下单(走限流队列, 与其他任务正确排队)
      }
      if (!["not-released", "release-pending", "rate-limited", "transient"].includes(classification) || attempt >= maxAttempts || (classification === "release-pending" && attempt >= releaseMaxAttempts)) break;
      if (classification === "release-pending" && releaseElapsedMs >= releaseWindowMs) break;
      const delay = linearRetryDelay(profile, classification);
      if (classification === "rate-limited") applyCooldown(scopeKey, delay);
      const loggedDelay = classification === "release-pending" ? releaseInterval : delay;
      console.warn("[grab] job=" + job.id + " retry=" + (attempt + 1) + "/" + (classification === "release-pending" ? releaseMaxAttempts : maxAttempts) + " class=" + classification + " delayMs=" + loggedDelay + (classification === "release-pending" ? " fastRelease=true" : ""));
      // The serial limiter already enforces minIntervalMs plus jitter after every booking call.
      if (classification !== "release-pending") await new Promise((resolve) => setTimeout(resolve, delay));
    }
    let elapsedMs = Date.now() - startedMs;
    // 主目标失败后依次尝试备选目标(同球场同凭证, date/payMethod 沿用主任务, 成功即停)
    // 备选同样走限流队列(同 scope 排队), 其结果继续进入待支付/兜底/终态统一流程
    const alternates = Array.isArray(job.target?.alternates) ? job.target.alternates : [];
    const alternateFailures = [];
    if (result?.success !== true && alternates.length) {
      for (let i = 0; i < alternates.length; i++) {
        const alt = alternates[i];
        const altTarget = { ...job.target, alternates: undefined };
        if (alt.court != null) altTarget.court = alt.court;
        if (Array.isArray(alt.courts)) altTarget.courts = alt.courts;
        if (alt.courtUid != null) altTarget.courtUid = alt.courtUid;
        if (alt.time) altTarget.time = alt.time;
        if (alt.cost != null) { altTarget.cost = alt.cost; altTarget.ext = { ...altTarget.ext, totalCost: alt.cost }; }
        let altResult = null;
        let altDispatchedMs = null;
        try {
          const limiterProfile = { ...adapterProfile, scopeKey: `${adapterProfile.scopeKey || job.venueId}:${job.userId}` };
          altResult = await enqueueBooking(job.venueId, limiterProfile, async () => {
            altDispatchedMs = Date.now();
            console.log(`[dispatch] job=${job.id} alternate=${i + 1}/${alternates.length} at=${new Date(altDispatchedMs).toISOString()}`);
            return venue.grab(altTarget, credential);
          }, { priority: "high" });
        } catch (e) { altResult = { success: false, message: String(e.message || e) }; }
        const altClass = altResult?.success === true ? "success" : "alternate-failed";
        const altFinishedMs = Date.now();
        const altCourts = Array.isArray(alt.courts)
          ? alt.courts.map((court) => `${court.court || court.courtUid || ""} ${court.time || ""}`.trim()).join(" + ")
          : String(alt.court || alt.courtUid || "");
        const altLabel = `${altCourts} ${!Array.isArray(alt.courts) ? (alt.time || "") : ""}`.trim() || "未命名备选";
        const altMessage = String(altResult?.message || (altResult?.success ? "下单成功" : "未知失败")).slice(0, 160);
        recordAttempt(job, 100 + i + 1, altDispatchedMs || altFinishedMs, altClass, altDispatchedMs ? altFinishedMs - altDispatchedMs : 0, `[备选${i + 1}] ${altMessage}`);
        console[altResult?.success === true ? "log" : "warn"](`[grab] job=${job.id} alternate=${i + 1}/${alternates.length} ${altResult?.success === true ? "success" : "failed"} target=${altLabel} message=${altMessage}`);
        if (altResult?.success === true) {
          result = { ...altResult, message: `主目标失败（${result?.message || "未知"}），已改用备选 ${altLabel} 下单成功：${altResult.message || ""}` };
          break;
        }
        alternateFailures.push({ attempt: 100 + i + 1, index: i + 1, target: altTarget, label: altLabel, message: altMessage });
      }
      if (result?.success !== true && alternateFailures.length) {
        let diagnosticSlots = null;
        if (alternateFailures.some((failure) => /不可约|不可预约/.test(failure.message)) && typeof venue.listSlots === "function") {
          try { diagnosticSlots = await venue.listSlots({ date: job.target?.date }, credential); } catch {}
        }
        const details = alternateFailures.map((failure) => {
          const reason = diagnosticSlots ? unavailableReasonFromSlots(failure.target, diagnosticSlots) : null;
          const message = reason && !failure.message.includes(reason) ? `${failure.message}（${reason}）` : failure.message;
          try { db.prepare("UPDATE job_attempts SET message=? WHERE job_id=? AND attempt=?").run(`[备选${failure.index}] ${message}`, job.id, failure.attempt); } catch {}
          if (reason) console.warn(`[grab] job=${job.id} alternate=${failure.index}/${alternates.length} detail=${reason}`);
          return `备选${failure.index} ${failure.label}：${message}`;
        });
        result = { ...result, message: `${result?.message || "主目标失败"}；已尝试 ${details.length} 个备选，均未成功（${details.join("；")}）` };
      }
    }
    elapsedMs = Date.now() - startedMs;
    if (requiresManualPayment(job, result)) {
      console.log(`[grab] job=${job.id} venue=${job.venueId} awaiting-payment elapsedMs=${elapsedMs} orderId=${result.orderId} message=${String(result.message || "订单已创建").slice(0, 160)}`);
      markAwaitingPayment(job, result, elapsedMs);
      return;
    }
    if (result?.success !== true && fallbackEnabled(job)) {
      // 余额支付失败(如授权方余额不足)时, 用创建任务者本人余额兜底
      const fallback = await creatorBalanceFallback(job, Date.now());
      if (fallback?.success === true) result = { ...fallback, message: `${result?.message || "抢订失败"}，已改用本人余额支付兜底成功` };
      else if (fallback) result = { ...result, message: `${result?.message || "抢订失败"}；本人余额兜底未成功: ${fallback.message}` };
    }
    if (result?.success !== true) {
      // 下单"不可约"失败后回查场次状态细分原因: 已被预约=真被人抢走(脚本慢), 已被锁场/排课=时段本身不可抢(等放场无意义)
      const reason = await refineUnavailableReason(venue, job, credential, result?.message);
      if (reason && !String(result.message || "").includes(reason)) result = { ...result, message: `${result.message}（${reason}）` };
    }
    const outcome = result?.success ? "success" : "failed";
    console[result?.success ? "log" : "warn"](`[grab] job=${job.id} venue=${job.venueId} ${outcome} elapsedMs=${elapsedMs}${result?.orderId ? ` orderId=${result.orderId}` : ""} message=${String(result?.message || "").slice(0, 160)}`);
    const completed = updateJob(job.id, { status: result?.success ? "done" : "failed", result: { ...result, elapsedMs } });
    if (completed) {
      notifyJobResult(completed).catch((error) => console.warn("[notification]", error.message));
      archiveJob(completed.id);
      if (result?.success) {
        for (const stopped of stopPendingSiblingsAfterAnySuccess(completed.groupUid, completed.id)) {
          notifyJobResult(stopped).catch(() => {});
        }
      }
      finalizeAndRepeatGroup(completed.groupUid);
    }
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
