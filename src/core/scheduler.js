/**
 * 璋冨害鍣?(楂樼簿搴︽姠璐増):
 *  1) 绮剧‘寮€鎶? 鍒?job.fireAt 鏃跺埢姣绾у彂灏? 鎻愬墠 preheat 棰勭儹闀胯繛鎺?
 *  2) ready 蹇冭烦: 姣忓皬鏃跺鏈変换鍔＄殑鐞冨満鍋氫竴娆?ready 妫€娴?
 *  3) 涓磋繎寮€鎶㈠姞瀵嗘娴? 浠讳竴 pending 浠诲姟寮€鎶㈠墠 10 鍒嗛挓鍐? 姣忓垎閽?ready 涓€娆?
 *
 * 绮惧害瀹炵幇瑕佺偣:
 *   - tick 姣?5s 鎵弿 pending 浠诲姟, 鍙戠幇 fireAt 璺濅粖 <= LOOKAHEAD_MS 灏变负鍏剁櫥璁颁竴涓簿纭?setTimeout
 *   - setTimeout 鍒扮偣鍓?PREHEAT_MS 鍐呭厛 preheat(寤鸿繛/鐑韩), 鍒扮偣鐢ㄩ鏋勫缓璇锋眰 fire
 *   - 绔嬪嵆鎵ц(fireAt=null 鎴栧凡杩囧幓)鐩存帴璺?
 *   - 鐢?scheduled 闆嗗悎闃查噸澶嶇櫥璁?
 */
import { listJobs, updateJob } from "./jobStore.js";
import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";
import { enqueueBooking, applyCooldown } from "./requestLimiter.js";
import { getRiskProfile, recordRiskEvent } from "./riskProfile.js";

const TICK_MS = 5 * 1000;             // 涓诲惊鐜? 5 绉掓壂涓€娆?
const LOOKAHEAD_MS = 60 * 1000;       // 璺?fireAt <= 60s 鏃剁櫥璁扮簿纭畾鏃?
const PREHEAT_MS = 15 * 1000;         // 鎻愬墠 15s 寮€濮嬮鐑?

export const readyCache = new Map();
let lastHourlyCheck = 0;
const lastMinuteCheck = new Map();
const scheduled = new Set();          // 宸茬櫥璁扮簿纭畾鏃剁殑 jobId

let timer = null;

export function startScheduler() {
  if (timer) return;
  console.log("[scheduler] 鍚姩, tick=%ds, lookahead=%ds, preheat=%ds",
    TICK_MS / 1000, LOOKAHEAD_MS / 1000, PREHEAT_MS / 1000);
  timer = setInterval(tick, TICK_MS);
  tick();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  const now = Date.now();
  const jobs = listJobs();

  for (const job of jobs) {
    if (job.status !== "pending") continue;
    const fire = job.fireAt ? new Date(job.fireAt).getTime() : 0;

    // 绔嬪嵆鎵ц (fireAt 鏈鎴栧凡杩囧緢涔?
    if (!job.fireAt || fire <= now) {
      if (!scheduled.has(job.id)) {
        scheduled.add(job.id);
        runGrab(job).catch((e) => console.error("[grab] error", e));
      }
      continue;
    }

    // 璺濆紑鎶?<= LOOKAHEAD_MS: 鐧昏绮剧‘瀹氭椂
    const diff = fire - now;
    if (diff <= LOOKAHEAD_MS && !scheduled.has(job.id)) {
      scheduled.add(job.id);
      schedulePreciseFire(job, fire);
    }
  }

  // 姣忓皬鏃?ready 蹇冭烦
  if (now - lastHourlyCheck >= 60 * 60 * 1000) {
    lastHourlyCheck = now;
    doReadyCheckAll("hourly");
  }

  // 涓磋繎寮€鎶?10鍒嗛挓)姣忓垎閽熸娴?
  const soonVenues = new Set();
  for (const job of jobs) {
    if (job.status !== "pending" || !job.fireAt) continue;
    const fire = new Date(job.fireAt).getTime();
    const diff = fire - now;
    if (diff > 0 && diff <= 10 * 60 * 1000) soonVenues.add(job.venueId);
  }
  for (const venueId of soonVenues) {
    const last = lastMinuteCheck.get(venueId) || 0;
    if (now - last >= 60 * 1000) {
      lastMinuteCheck.set(venueId, now);
      doReadyCheck(venueId, "pre-grab-1min");
    }
  }
}

/**
 * 绮剧‘瀹氭椂: 鎻愬墠棰勭儹 -> 鍒?fireAt 姣鍙戝皠
 */
function schedulePreciseFire(job, fireAtMs) {
  const now = Date.now();
  const untilPreheat = Math.max(0, fireAtMs - PREHEAT_MS - now);
  const untilFire = Math.max(0, fireAtMs - now);

  const venue = getVenue(job.venueId);
  if (!venue) {
    updateJob(job.id, { status: "failed", result: { message: "鏈煡鐞冨満: " + job.venueId } });
    return;
  }
  const cred = getCredential(job.venueId);

  // 棰勭儹
  setTimeout(async () => {
    try {
      if (typeof venue.preheat === "function") {
        const r = await venue.preheat(cred);
        console.log(`[preheat] ${job.venueId} -> ${r.ok ? "OK" : "FAIL"} ${r.detail || ""}`);
      }
    } catch (e) {
      console.warn("[preheat] error:", e.message);
    }
  }, untilPreheat);

  // 绮剧‘鍙戝皠
  setTimeout(() => {
    runGrab(job, cred, venue).catch((e) => console.error("[grab] error", e));
  }, untilFire);

  const fireIso = new Date(fireAtMs).toISOString();
  console.log(`[schedule] job ${job.id} 宸茬櫥璁扮簿纭畾鏃? fireAt=${fireIso}, preheatIn=${untilPreheat}ms, fireIn=${untilFire}ms`);
}

/**
 * 鎵ц鎶㈣喘. 浼樺厛璧?buildGrabRequest + fireGrab (棰勬瀯寤? 楂樼簿搴?; 鍏煎 grab().
 */
async function runGrab(job, credArg, venueArg) {
  updateJob(job.id, { status: "running" });
  const venue = venueArg || getVenue(job.venueId);
  if (!venue) {
    updateJob(job.id, { status: "failed", result: { message: "鏈煡鐞冨満: " + job.venueId } });
    return;
  }
  const cred = credArg || getCredential(job.venueId);
  let profile = getRiskProfile(job.venueId, venue.riskProfile || {});
  const MAX_RETRY = Math.min(10, Number((job.target.ext && job.target.ext.maxRetry) || profile.booking.maxRetry));

  // 棣栧彂鍓嶅啀棰勬瀯寤轰竴娆?鑰楁椂 <1ms), 淇濊瘉鍑瘉鏄渶鏂扮殑
  let prebuilt = null;
  if (typeof venue.buildGrabRequest === "function") {
    try { prebuilt = venue.buildGrabRequest(job.target, cred); } catch {}
  }

  let result = null;
  const t0 = Date.now();
  for (let i = 1; i <= MAX_RETRY; i++) {
    try {
      result = await enqueueBooking(job.venueId, venue.riskProfile || {}, async () => {
        if (prebuilt && typeof venue.fireGrab === "function") return venue.fireGrab(prebuilt);
        return venue.grab(job.target, cred);
      });
      profile = recordRiskEvent(job.venueId, result.success ? "success" : isRateLimited(result) ? "rate-limited" : "request", venue.riskProfile || {});
      if (result.success) break;
    } catch (e) {
      result = { success: false, message: String(e) };
      recordRiskEvent(job.venueId, "request", venue.riskProfile || {});
    }
    if (i < MAX_RETRY && isRetryable(result)) {
      const delay = retryDelay(profile, i);
      if (isRateLimited(result)) applyCooldown(job.venueId, profile.booking.cooldownMs);
      console.warn("[grab] retry "+(i + 1)+"/"+MAX_RETRY+" in "+delay+"ms: "+result.message);
      await new Promise((r) => setTimeout(r, delay));
    } else if (i < MAX_RETRY) {
      break;
    }
  }
  const elapsed = Date.now() - t0;
  updateJob(job.id, {
    status: result && result.success ? "done" : "failed",
    result: { ...result, elapsedMs: elapsed },
  });
  console.log(`[grab] job ${job.id} -> ${result && result.success ? "鎴愬姛" : "澶辫触"} (${elapsed}ms): ${result && result.message}`);
}

function isRateLimited(result) {
  const text = JSON.stringify(result || {}).toLowerCase();
  return text.includes("操作太频繁") || text.includes("操作頻繁") || text.includes("too frequent") || text.includes("429");
}

function isRetryable(result) {
  if (!result || result.success) return false;
  if (isRateLimited(result)) return true;
  const text = String(result.message || result).toLowerCase();
  return text.includes("timeout") || text.includes("aborted") || text.includes("econn") || text.includes("503") || text.includes("502");
}

function retryDelay(profile, attempt) {
  const configured = profile.booking.backoff && profile.booking.backoff[attempt - 1];
  if (configured) return configured + Math.floor(Math.random() * Math.max(250, profile.booking.jitterMs));
  return Math.min(60000, 3000 * (2 ** (attempt - 1))) + Math.floor(Math.random() * Math.max(250, profile.booking.jitterMs));
}

export async function doReadyCheck(venueId, reason = "manual") {
  const venue = getVenue(venueId);
  if (!venue) return { ok: false, detail: "鏈煡鐞冨満" };
  const cred = getCredential(venueId);
  let res;
  try {
    res = await venue.ready(cred);
  } catch (e) {
    res = { ok: false, detail: String(e) };
  }
  readyCache.set(venueId, { at: new Date().toISOString(), reason, result: res });
  console.log(`[ready:${reason}] ${venueId} -> ${res.ok ? "OK" : "FAIL"} ${res.detail || ""}`);
  return res;
}

export async function doReadyCheckAll(reason) {
  const jobs = listJobs();
  const venueIds = new Set(jobs.map((j) => j.venueId));
  for (const venueId of venueIds) {
    await doReadyCheck(venueId, reason);
  }
}


