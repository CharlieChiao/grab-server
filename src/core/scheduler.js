import { listJobs, updateJob, archiveJob } from "./jobStore.js";
import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";
import { enqueueBooking, applyCooldown } from "./requestLimiter.js";
import { getRiskProfile, recordRiskEvent } from "./riskProfile.js";
import { db } from "./database.js";
import { notifyJobResult } from "./notifications.js";
import { finalizeAndRepeatGroup, stopPendingSiblingsAfterAnySuccess } from "./jobGroups.js";
import { creatorBalanceFallback, expireAwaitingPayments, fallbackEnabled, markAwaitingPayment, pollAwaitingPayments, requiresManualPayment, targetSlotsAvailable } from "./paymentLifecycle.js";
import { normalizeFailure } from "./failureReasons.js";

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
  let preparedTargetPromise = null;
  setTimeout(async () => {
    // 次卡选择本身需要一次网络查询；和连接预热一起提前完成，避免到点后才查卡拖慢首发。
    if (typeof venue.prepareTarget === "function") {
      preparedTargetPromise = prepareBookingTarget(venue, job.target, credential).catch((e) => {
        console.warn(`[preheat] job=${job.id} payment preparation failed: ${e.message}`);
        return null; // 到点时再试一次，避免短暂查询失败直接终止任务
      });
    }
    try {
      const tasks = [];
      if (typeof venue.preheat === "function") tasks.push(venue.preheat(credential));
      if (preparedTargetPromise) tasks.push(preparedTargetPromise);
      await Promise.all(tasks);
    } catch (e) { console.warn("[preheat]", e.message); }
  }, Math.max(0, fireMs - PREHEAT_MS - Date.now()));
  setTimeout(() => runGrab(job, credential, venue, preparedTargetPromise).catch((e) => console.error("[grab]", e)), Math.max(0, fireMs - Date.now()));
  console.log(`[schedule] job=${job.id} fireAt=${new Date(fireMs).toISOString()}`);
}

export async function prepareBookingTarget(venue, target, credential) {
  return typeof venue?.prepareTarget === "function" ? venue.prepareTarget(target, credential) : target;
}

function wantedSlots(target) {
  return Array.isArray(target?.courts) && target.courts.length
    ? target.courts.map((c) => ({ uid: c.courtUid, court: c.court, time: c.time || target.time }))
    : [{ uid: target?.courtUid, court: target?.court, time: target?.time }];
}

function matchingUnavailableSlots(target, slots) {
  const wanted = wantedSlots(target);
  return (slots || []).filter((slot) => wanted.some((item) => {
    const courtMatch = item.uid ? String(slot.uid) === String(item.uid) : String(slot.court || "") === String(item.court || "");
    return courtMatch && String(slot.begin || "").slice(11, 16) === String(item.time || "").slice(0, 5) && !slot.canAppoint;
  }));
}

function displaySlotReason(slot) {
  return String(slot.reason || slot.message || slot.slotStatus || "不可约");
}

export function unavailableReasonFromSlots(target, slots) {
  const reasons = matchingUnavailableSlots(target, slots).map(displaySlotReason);
  return [...new Set(reasons)].join("、") || null;
}

export function classifyFailure(venue, result) {
  if (typeof venue?.classifyFailure === "function") return venue.classifyFailure(result);
  if (result?.failure?.classification) return result.failure;
  return normalizeFailure(result?.success === true ? "success" : "unknown", { classification: classifyResult(result) }, result?.message);
}

export async function refineUnavailableFailure(venue, job, credential, failure) {
  if (failure?.inspectSlots !== true || typeof venue?.listSlots !== "function") return null;
  try {
    const slots = await venue.listSlots({ date: job.target?.date }, credential);
    const matched = matchingUnavailableSlots(job.target, slots);
    const details = matched.map((slot) => ({
      failure: classifyFailure(venue, { success: false, message: slot.message, slotStatus: slot.slotStatus || slot.status }),
      message: displaySlotReason(slot),
    }));
    const decisive = details.find((item) => ["occupied", "scheduled", "locked"].includes(item.failure.kind));
    return { failure: decisive?.failure || null, message: [...new Set(details.map((item) => item.message))].join("、") || null };
  } catch {
    return null;
  }
}

// Compatibility helper for callers that only need the display reason.
export async function refineUnavailableReason(venue, job, credential, messageOrFailure) {
  const failure = typeof messageOrFailure === "object"
    ? messageOrFailure
    : classifyFailure(venue, { success: false, message: String(messageOrFailure || "") });
  return (await refineUnavailableFailure(venue, job, credential, failure))?.message || null;
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

async function runGrab(job, credentialArg, venueArg, preparedTargetPromiseArg = null) {
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
    const preheatedTarget = preparedTargetPromiseArg ? await preparedTargetPromiseArg : null;
    const preparedTarget = preheatedTarget || await prepareBookingTarget(venue, job.target, credential);
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
      let failure = classifyFailure(venue, result);
      let classification = failure.classification;
      const releaseElapsedMs = job.fireAt ? Math.max(0, Date.now() - new Date(job.fireAt).getTime()) : Number.POSITIVE_INFINITY;
      const releaseWindowMs = Number(retryPolicy.unavailableGraceMs || 0);
      const unavailableText = String(result?.message || "");
      if (failure.inspectSlots && releaseWindowMs > 0 && releaseElapsedMs <= releaseWindowMs) {
        // 适配器声明“需要回查场次”后才诊断；核心只读取结构化 kind，不解析平台文案。
        const refined = await refineUnavailableFailure(venue, job, credential, failure);
        if (refined?.failure && ["occupied", "scheduled", "locked"].includes(refined.failure.kind)) {
          failure = refined.failure;
          classification = failure.classification;
          result = { ...result, failure, message: refined.message && !unavailableText.includes(refined.message) ? `${unavailableText}（${refined.message}）` : unavailableText };
          console.log(`[grab] job=${job.id} slot ${failure.kind} (${refined.message || failure.message}), abandoning remaining attempts`);
        } else {
          failure = normalizeFailure("not_released", { classification: "release-pending", retryable: true }, unavailableText);
          classification = failure.classification;
          result = { ...result, failure };
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
          // 备选场次也必须重新执行支付准备；次卡是否可用取决于具体场地和时段。
          const preparedAltTarget = await prepareBookingTarget(venue, altTarget, credential);
          const limiterProfile = { ...adapterProfile, scopeKey: `${adapterProfile.scopeKey || job.venueId}:${job.userId}` };
          altResult = await enqueueBooking(job.venueId, limiterProfile, async () => {
            altDispatchedMs = Date.now();
            console.log(`[dispatch] job=${job.id} alternate=${i + 1}/${alternates.length} at=${new Date(altDispatchedMs).toISOString()}`);
            return venue.grab(preparedAltTarget, credential);
          }, { priority: "high" });
        } catch (e) { altResult = { success: false, message: String(e.message || e) }; }
        const altFailure = classifyFailure(venue, altResult);
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
        alternateFailures.push({ attempt: 100 + i + 1, index: i + 1, target: altTarget, label: altLabel, message: altMessage, failure: altFailure });
      }
      if (result?.success !== true && alternateFailures.length) {
        let diagnosticSlots = null;
        if (alternateFailures.some((item) => item.failure?.inspectSlots) && typeof venue.listSlots === "function") {
          try { diagnosticSlots = await venue.listSlots({ date: job.target?.date }, credential); } catch {}
        }
        const details = alternateFailures.map((failure) => {
          const reason = diagnosticSlots && failure.failure?.inspectSlots ? unavailableReasonFromSlots(failure.target, diagnosticSlots) : null;
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
      // 按适配器声明的结构化能力回查场次，只把明细文本用于展示。
      const reason = await refineUnavailableReason(venue, job, credential, classifyFailure(venue, result));
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
  if (result?.failure?.classification) return result.failure.classification;
  if ([429, "429"].includes(result?.status) || [429, "429"].includes(result?.code)) return "rate-limited";
  if (result?.transient === true) return "transient";
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
