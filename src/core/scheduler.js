/**
 * 调度器 (高精度抢购版):
 *  1) 精确开抢: 到 job.fireAt 时刻毫秒级发射; 提前 preheat 预热长连接
 *  2) ready 心跳: 每小时对有任务的球场做一次 ready 检测
 *  3) 临近开抢加密检测: 任一 pending 任务开抢前 10 分钟内, 每分钟 ready 一次
 *
 * 精度实现要点:
 *   - tick 每 5s 扫描 pending 任务, 发现 fireAt 距今 <= LOOKAHEAD_MS 就为其登记一个精确 setTimeout
 *   - setTimeout 到点前 PREHEAT_MS 内先 preheat(建连/热身), 到点用预构建请求 fire
 *   - 立即执行(fireAt=null 或已过去)直接跑
 *   - 用 scheduled 集合防重复登记
 */
import { listJobs, updateJob } from "./jobStore.js";
import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";

const TICK_MS = 5 * 1000;             // 主循环: 5 秒扫一次
const LOOKAHEAD_MS = 60 * 1000;       // 距 fireAt <= 60s 时登记精确定时
const PREHEAT_MS = 15 * 1000;         // 提前 15s 开始预热

export const readyCache = new Map();
let lastHourlyCheck = 0;
const lastMinuteCheck = new Map();
const scheduled = new Set();          // 已登记精确定时的 jobId

let timer = null;

export function startScheduler() {
  if (timer) return;
  console.log("[scheduler] 启动, tick=%ds, lookahead=%ds, preheat=%ds",
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

    // 立即执行 (fireAt 未设或已过很久)
    if (!job.fireAt || fire <= now) {
      if (!scheduled.has(job.id)) {
        scheduled.add(job.id);
        runGrab(job).catch((e) => console.error("[grab] error", e));
      }
      continue;
    }

    // 距开抢 <= LOOKAHEAD_MS: 登记精确定时
    const diff = fire - now;
    if (diff <= LOOKAHEAD_MS && !scheduled.has(job.id)) {
      scheduled.add(job.id);
      schedulePreciseFire(job, fire);
    }
  }

  // 每小时 ready 心跳
  if (now - lastHourlyCheck >= 60 * 60 * 1000) {
    lastHourlyCheck = now;
    doReadyCheckAll("hourly");
  }

  // 临近开抢(10分钟)每分钟检测
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
 * 精确定时: 提前预热 -> 到 fireAt 毫秒发射
 */
function schedulePreciseFire(job, fireAtMs) {
  const now = Date.now();
  const untilPreheat = Math.max(0, fireAtMs - PREHEAT_MS - now);
  const untilFire = Math.max(0, fireAtMs - now);

  const venue = getVenue(job.venueId);
  if (!venue) {
    updateJob(job.id, { status: "failed", result: { message: "未知球场: " + job.venueId } });
    return;
  }
  const cred = getCredential(job.venueId);

  // 预热
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

  // 精确发射
  setTimeout(() => {
    runGrab(job, cred, venue).catch((e) => console.error("[grab] error", e));
  }, untilFire);

  const fireIso = new Date(fireAtMs).toISOString();
  console.log(`[schedule] job ${job.id} 已登记精确定时, fireAt=${fireIso}, preheatIn=${untilPreheat}ms, fireIn=${untilFire}ms`);
}

/**
 * 执行抢购. 优先走 buildGrabRequest + fireGrab (预构建, 高精度); 兼容 grab().
 */
async function runGrab(job, credArg, venueArg) {
  updateJob(job.id, { status: "running" });
  const venue = venueArg || getVenue(job.venueId);
  if (!venue) {
    updateJob(job.id, { status: "failed", result: { message: "未知球场: " + job.venueId } });
    return;
  }
  const cred = credArg || getCredential(job.venueId);
  const MAX_RETRY = (job.target.ext && job.target.ext.maxRetry) || 20;
  const INTERVAL = (job.target.ext && job.target.ext.retryInterval) || 200;

  // 首发前再预构建一次(耗时 <1ms), 保证凭证是最新的
  let prebuilt = null;
  if (typeof venue.buildGrabRequest === "function") {
    try { prebuilt = venue.buildGrabRequest(job.target, cred); } catch {}
  }

  let result = null;
  const t0 = Date.now();
  for (let i = 1; i <= MAX_RETRY; i++) {
    try {
      if (prebuilt && typeof venue.fireGrab === "function") {
        result = await venue.fireGrab(prebuilt);
      } else {
        result = await venue.grab(job.target, cred);
      }
      if (result.success) break;
    } catch (e) {
      result = { success: false, message: String(e) };
    }
    if (i < MAX_RETRY) await new Promise((r) => setTimeout(r, INTERVAL));
  }
  const elapsed = Date.now() - t0;
  updateJob(job.id, {
    status: result && result.success ? "done" : "failed",
    result: { ...result, elapsedMs: elapsed },
  });
  console.log(`[grab] job ${job.id} -> ${result && result.success ? "成功" : "失败"} (${elapsed}ms): ${result && result.message}`);
}

export async function doReadyCheck(venueId, reason = "manual") {
  const venue = getVenue(venueId);
  if (!venue) return { ok: false, detail: "未知球场" };
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
