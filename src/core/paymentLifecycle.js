import { listJobs, updateJob, archiveJob } from "./jobStore.js";
import { notifyJobResult } from "./notifications.js";
import { finalizeAndRepeatGroup } from "./jobGroups.js";
import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";
import { enqueueBooking } from "./requestLimiter.js";
import { getActiveDelegation } from "./delegations.js";

export const PAYMENT_TIMEOUT_MINUTES = 15;
// listSlots 是查询接口, releaseProbe 校准以 250ms 间隔探测都未触发限流, 1s 轮询安全; 下单接口的风控阈值约 2s, 由 enqueueBooking 保证
const PAYMENT_POLL_MS = 1000;
const polling = new Set();
const lastPolledAt = new Map();

export function requiresWechatPayment(job, result) {
  return !!job?.delegated && Number(job?.target?.ext?.payMethod) === 900 && !!result?.success && !!result?.orderId;
}

export function markAwaitingPayment(job, result, elapsedMs, now = Date.now()) {
  const timeoutMs = PAYMENT_TIMEOUT_MINUTES * 60 * 1000;
  return updateJob(job.id, { status: "awaiting_payment", result: { ...result, success: null, message: "订单已创建，等待授权用户支付", elapsedMs, paymentStatus: "pending", paymentStartedAt: new Date(now).toISOString(), paymentExpiresAt: new Date(now + timeoutMs).toISOString(), paymentTimeoutMinutes: PAYMENT_TIMEOUT_MINUTES } });
}

export function finishPayment(jobId, now = Date.now()) {
  const job = listJobs().find((item) => item.id === jobId);
  if (!job || job.status !== "awaiting_payment") return null;
  const completed = updateJob(job.id, { status: "done", result: { ...job.result, success: true, message: "微信支付成功，预约已确认", paymentStatus: "paid", paidAt: new Date(now).toISOString() } });
  if (completed) finishAndArchive(completed);
  return completed;
}

// 兜底开关: 仅委托任务, 由创建任务时前端传入
export function fallbackEnabled(job) {
  return job?.delegated === true && job?.target?.ext?.fallbackBalance === true;
}

// 以 paymentStartedAt 计算实际等待 ms; 无起点时回退到窗口值
function paymentElapsedMs(job, now) {
  const startedAt = Date.parse(job.result?.paymentStartedAt || "");
  if (Number.isFinite(startedAt)) return Math.max(0, now - startedAt);
  return Number(job.result?.paymentTimeoutMinutes || PAYMENT_TIMEOUT_MINUTES) * 60000;
}

// "X 分 Y 秒" 展示, 与 1s 轮询精度匹配
function formatWait(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`;
}

function releasedBaseMessage(job, now) {
  return `场次已释放，判定支付失败（实际等待 ${formatWait(paymentElapsedMs(job, now))}）`;
}

// 单次余额下单尝试, 返回 {success, message, ...grab 结果}
async function attemptBalanceBooking(venue, job, credential) {
  try {
    const target = { ...job.target, ext: { ...job.target.ext, payMethod: 40 } };
    return await enqueueBooking(job.venueId, venue.riskProfile || {}, () => venue.grab(target, credential));
  } catch (error) {
    return { success: false, message: String(error?.message || error) };
  }
}

// 余额支付抢订失败时(如授权方余额不足), 用创建任务者(A)本人凭证余额兜底下单
export async function creatorBalanceFallback(job) {
  const venue = getVenue(job.venueId);
  if (!venue) return null;
  const credential = getCredential(job.venueId, job.createdByUserId);
  if (!credential) return { success: false, message: "本人未配置该场馆凭证" };
  return attemptBalanceBooking(venue, job, credential);
}

// 两层兜底: 先用授权方(B)余额, 不足或未授权时改用创建任务者(A)本人余额, 确保订上场
export async function fallbackBalanceBooking(job, baseMessage, now) {
  const guard = updateJob(job.id, { status: "running", result: { ...job.result, success: null, message: `${baseMessage}，正在尝试余额支付兜底`, paymentStatus: "fallback" } });
  if (!guard) return null;
  const venue = getVenue(job.venueId);
  let ownerResult = { success: false, message: `unknown venue: ${job.venueId}` };
  if (venue) {
    const delegation = getActiveDelegation(job.userId, job.createdByUserId);
    let allowed = [];
    try { allowed = JSON.parse(delegation?.allowed_payments_json || "[]"); } catch {}
    if (!delegation) ownerResult = { success: false, message: "授权已失效" };
    else if (!allowed.includes("balance")) ownerResult = { success: false, message: "授权方未允许余额支付" };
    else {
      const credential = getCredential(job.venueId, job.userId);
      ownerResult = credential ? await attemptBalanceBooking(venue, job, credential) : { success: false, message: "授权方未配置场馆凭证" };
    }
  }
  let result = ownerResult;
  let message = `${baseMessage}，已自动用授权方余额支付兜底成功`;
  let fallbackBy = "owner";
  if (ownerResult?.success !== true) {
    // 第二层: 用创建任务者(A)本人的凭证和余额下单, 花的是 A 自己的钱, 无需 B 的授权
    if (!venue) { message = `${baseMessage}，余额兜底未成功: ${ownerResult.message}`; fallbackBy = "none"; }
    else {
      const ownCredential = getCredential(job.venueId, job.createdByUserId);
      const ownResult = ownCredential ? await attemptBalanceBooking(venue, job, ownCredential) : { success: false, message: "本人未配置该场馆凭证" };
      result = ownResult;
      if (ownResult?.success === true) {
        message = `${baseMessage}，授权方余额支付未成功（${ownerResult.message}），已改用本人余额支付兜底成功`;
        fallbackBy = "creator";
      } else {
        message = `${baseMessage}，余额兜底未成功: ${ownerResult.message}；本人兜底: ${ownResult.message}`;
        fallbackBy = "none";
      }
    }
  }
  const paid = result?.success === true;
  const completed = updateJob(job.id, { status: paid ? "done" : "failed", result: { ...job.result, ...result, success: paid, message, paymentStatus: paid ? "fallback-paid" : "fallback-failed", paymentFallbackBy: fallbackBy, paymentFallbackAt: new Date(now).toISOString() } });
  if (completed) finishAndArchive(completed);
  return completed;
}

export async function pollAwaitingPayments(now = Date.now()) {
  for (const job of listJobs()) {
    if (job.status !== "awaiting_payment" || polling.has(job.id) || now - (lastPolledAt.get(job.id) || 0) < PAYMENT_POLL_MS) continue;
    const expiresAt = Date.parse(job.result?.paymentExpiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt <= now) continue;
    const venue = getVenue(job.venueId);
    if (!venue || typeof venue.listSlots !== "function") continue;
    polling.add(job.id);
    lastPolledAt.set(job.id, now);
    try {
      const slots = await venue.listSlots({ date: job.target?.date }, getCredential(job.venueId, job.userId));
      if (targetSlotsAvailable(job.target, slots)) {
        if (fallbackEnabled(job)) await fallbackBalanceBooking(job, releasedBaseMessage(job, now), now);
        else failReleasedPayment(job.id, now);
      }
    } catch (error) {
      console.warn(`[payment-poll] job=${job.id} ${String(error?.message || error)}`);
    } finally {
      polling.delete(job.id);
    }
  }
}

export function targetSlotsAvailable(target, slots) {
  const wanted = Array.isArray(target?.courts) && target.courts.length
    ? target.courts.map((court) => typeof court === "string" ? { court, time: target.time } : { court: court.court, uid: court.courtUid, time: court.time || target.time })
    : [{ court: target?.court, uid: target?.courtUid, time: target?.time }];
  return wanted.some((item) => (slots || []).some((slot) => {
    const sameCourt = item.uid ? String(slot.uid) === String(item.uid) : String(slot.court || "") === String(item.court || "");
    const begin = String(slot.begin || "");
    const timeMatch = /(?:T|\s)(\d{2}:\d{2})/.exec(begin);
    const sameTime = !item.time || (timeMatch ? timeMatch[1] : begin.slice(0, 5)) === String(item.time).slice(0, 5);
    const available = slot.canAppoint === true || slot.canAppoint === 1 || String(slot.canAppoint).toLowerCase() === "true";
    return sameCourt && sameTime && available;
  }));
}

function failReleasedPayment(jobId, now) {
  const job = listJobs().find((item) => item.id === jobId);
  if (!job || job.status !== "awaiting_payment") return null;
  const completed = updateJob(job.id, { status: "failed", result: { ...job.result, success: false, message: releasedBaseMessage(job, now), paymentStatus: "released", paymentElapsedMs: paymentElapsedMs(job, now), paymentReleasedAt: new Date(now).toISOString() } });
  if (completed) finishAndArchive(completed);
  return completed;
}

export async function expireAwaitingPayments(now = Date.now()) {
  const expired = [];
  for (const job of listJobs()) {
    if (job.status !== "awaiting_payment") continue;
    const expiresAt = Date.parse(job.result?.paymentExpiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt > now) continue;
    const baseMessage = `支付超时（实际等待 ${formatWait(paymentElapsedMs(job, now))} 未完成付款）`;
    if (fallbackEnabled(job)) { await fallbackBalanceBooking(job, baseMessage, now); continue; }
    const completed = updateJob(job.id, { status: "failed", result: { ...job.result, success: false, message: baseMessage, paymentStatus: "timeout", paymentElapsedMs: paymentElapsedMs(job, now), paymentTimedOutAt: new Date(now).toISOString() } });
    if (completed) { expired.push(completed); finishAndArchive(completed); }
  }
  return expired;
}

function finishAndArchive(job) {
  notifyJobResult(job).catch((error) => console.warn("[notification]", error.message));
  archiveJob(job.id);
  finalizeAndRepeatGroup(job.groupUid);
}
