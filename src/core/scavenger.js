/**
 * 捡漏任务调度 — 持续轮询所选球场的 listSlots, 发现满足条件的可约场次立即下单。
 * 与一次性抢订(runGrab)不同: 无 fireAt, 每隔数秒+随机抖动(模拟人为刷新)检查一次;
 * 下单失败只记录不通知, 成功则通知。
 * 覆盖模型: 任务时段 [start,end] 用"已覆盖区间"记账(跨球场全局, 同一段时间不会重复订),
 * 全覆盖即任务完成; 允许部分预定时先订可订的, 剩余时段继续在后续轮询中搜索。
 */
import crypto from "node:crypto";
import { db, nowIso } from "./database.js";
import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";
import { enqueueBooking, applyCooldown } from "./requestLimiter.js";
import { notifyJobResult } from "./notifications.js";
import { classifyResult } from "./scheduler.js";
import { targetSlotsAvailable } from "./paymentLifecycle.js";

const TICK_MS = 1000;
const POLL_BASE_MS = Number(process.env.SCAVENGE_POLL_MS || 5000);   // 轮询基础间隔
const POLL_JITTER_MS = Number(process.env.SCAVENGE_POLL_JITTER_MS || 4000); // 随机抖动
const DAY_MS = 24 * 60 * 60 * 1000;
let timer = null;
const nextPollAt = new Map(); // taskId -> 下次轮询时间戳
const inFlight = new Set();

// ---------- 时间工具(北京时区, 分钟记账; end<=start 视为跨天自动 +24h) ----------
export function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function beijingMs(dateStr, minutes) {
  return Date.parse(`${dateStr}T00:00:00+08:00`) + minutes * 60000;
}

// ---------- 区间工具(纯函数, 供测试复用) ----------
export function mergeIntervals(intervals) {
  const sorted = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); // 相邻/重叠合并
    else merged.push([s, e]);
  }
  return merged;
}
export function subtractIntervals(range, covered) {
  let uncovered = [range];
  for (const [cs, ce] of mergeIntervals(covered)) {
    const next = [];
    for (const [s, e] of uncovered) {
      if (ce <= s || cs >= e) { next.push([s, e]); continue; }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    uncovered = next;
  }
  return uncovered.filter(([s, e]) => e > s);
}

// ---------- slot 归一化(两种适配器形状统一, end 统一按 venue slotMinutes 推算, 忽略银豹 20:59 偏移) ----------
export function normalizeSlot(slot, ctx) {
  // ctx: { slotMinutes, startMin, crossOvernight, date, nonRefundableHours, now }
  const beginRaw = String(slot.begin || "");
  const m = /(\d{2}):(\d{2})/.exec(beginRaw);
  if (!m) return null;
  let beginMin = Number(m[1]) * 60 + Number(m[2]);
  if (ctx.crossOvernight && beginMin < ctx.startMin) beginMin += 1440; // 跨天任务: 凌晨场次属于次日
  const duration = Math.max(30, Number(ctx.slotMinutes) || 60);
  const endMin = beginMin + duration;
  const available = slot.canAppoint === true || slot.canAppoint === 1 || String(slot.canAppoint).toLowerCase() === "true";
  const cost = Number(slot.cost || 0);
  let nonRefundable = false;
  const hours = Number(ctx.nonRefundableHours || 0);
  if (hours > 0) {
    const slotStartMs = beijingMs(ctx.date, beginMin);
    nonRefundable = slotStartMs - ctx.now < hours * 3600000;
  }
  return { court: String(slot.court || ""), uid: String(slot.uid ?? ""), beginMin, endMin, time: beginRaw.slice(11, 16) || `${m[1]}:${m[2]}`, cost, available, nonRefundable };
}

// ---------- 链搜索: 在 [from,to] 内用可约 slot 拼时间连续的链 ----------
// full: 精确铺满 [from,to]; partial: 任意连续子段。同价优先单场地(体验好), 预算内取最优。
export function findCandidates(slots, from, to, allowCombine, budget) {
  const within = slots.filter((s) => s.beginMin >= from && s.endMin <= to);
  const chains = [];
  const walk = (chain) => {
    const cost = chain.reduce((sum, x) => sum + x.cost, 0);
    if (cost > budget) return;
    chains.push({ chain: [...chain], full: chain[0].beginMin === from && chain[chain.length - 1].endMin === to });
    const end = chain[chain.length - 1].endMin;
    for (const next of within.filter((s) => s.beginMin === end && (allowCombine || s.uid === chain[0].uid))) walk([...chain, next]);
  };
  for (const s of within) walk([s]);
  const score = (c) => {
    const single = c.chain.every((x) => x.uid === c.chain[0].uid) ? 0 : 1;
    const len = c.chain[c.chain.length - 1].endMin - c.chain[0].beginMin;
    return { full: c.full, len, single, cost: c.chain.reduce((sum, x) => sum + x.cost, 0) };
  };
  const full = chains.filter((c) => c.full).sort((a, b) => score(a).cost - score(b).cost || score(a).single - score(b).single)[0] || null;
  const partial = chains.filter((c) => !c.full && c.chain.length).sort((a, b) => (score(b).len - score(a).len) || (a.chain[0].beginMin - b.chain[0].beginMin) || (score(a).cost - score(b).cost) || (score(a).single - score(b).single))[0] || null;
  return { full, partial };
}

// ---------- 存储 ----------
function rowToTask(row) {
  if (!row) return null;
  const startMin = hhmmToMinutes(row.start_time);
  let endMin = hhmmToMinutes(row.end_time);
  if (startMin == null || endMin == null) return null;
  if (endMin <= startMin) endMin += 1440; // 跨天
  let venueIds = [], bookings = [], stats = {};
  try { venueIds = JSON.parse(row.venue_ids_json); } catch {}
  try { bookings = JSON.parse(row.bookings_json); } catch {}
  try { stats = JSON.parse(row.stats_json || "{}"); } catch {}
  return {
    id: row.id, userId: row.user_id, venueIds, date: row.date, startTime: row.start_time, endTime: row.end_time,
    startMin, endMin, crossOvernight: endMin > 1440,
    allowCombine: !!row.allow_combine, allowPartial: !!row.allow_partial, allowNonrefundable: !!row.allow_nonrefundable,
    maxTotalCost: Number(row.max_total_cost),
    // 支付优先级: balance-first(余额优先, 余额不足自动改微信锁场) / wechat-first; 兼容旧单值
    payKind: row.pay_kind === "wechat-first" || row.pay_kind === "wechat" ? "wechat-first" : "balance-first",
    status: row.status,
    bookings, stats, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
export function createScavengeTask(userId, input) {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare("INSERT INTO scavenge_tasks(id,user_id,venue_ids_json,date,start_time,end_time,allow_combine,allow_partial,allow_nonrefundable,max_total_cost,pay_kind,status,bookings_json,stats_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, userId, JSON.stringify(input.venueIds), input.date, input.startTime, input.endTime,
      input.allowCombine === false ? 0 : 1, input.allowPartial === false ? 0 : 1, input.allowNonrefundable === false ? 0 : 1,
      input.maxTotalCost, input.payKind, "active", "[]", "{}", now, now);
  return getScavengeTask(id, userId);
}
export function getScavengeTask(id, userId) {
  return rowToTask(db.prepare("SELECT * FROM scavenge_tasks WHERE id=? AND user_id=?").get(id, userId));
}
export function listScavengeTasks(userId) {
  return db.prepare("SELECT * FROM scavenge_tasks WHERE user_id=? ORDER BY created_at DESC").all(userId).map(rowToTask).filter(Boolean);
}
function listActiveTasks() {
  return db.prepare("SELECT * FROM scavenge_tasks WHERE status='active'").all().map(rowToTask).filter(Boolean);
}
function updateTaskRow(id, patch) {
  const sets = [], values = [];
  if (patch.status !== undefined) { sets.push("status=?"); values.push(patch.status); }
  if (patch.bookings !== undefined) { sets.push("bookings_json=?"); values.push(JSON.stringify(patch.bookings)); }
  if (patch.stats !== undefined) { sets.push("stats_json=?"); values.push(JSON.stringify(patch.stats)); }
  if (!sets.length) return;
  sets.push("updated_at=?"); values.push(nowIso(), id);
  db.prepare(`UPDATE scavenge_tasks SET ${sets.join(",")} WHERE id=?`).run(...values);
}
export function stopScavengeTask(id, userId) {
  const task = getScavengeTask(id, userId);
  if (!task || task.status !== "active") return task;
  updateTaskRow(id, { status: "stopped" });
  return getScavengeTask(id, userId);
}

// ---------- 覆盖记账 ----------
function coveredOf(task) {
  return mergeIntervals(task.bookings.filter((b) => !b.released).map((b) => [b.startMin, b.endMin]));
}
function fullyCovered(task) {
  return subtractIntervals([task.startMin, task.endMin], coveredOf(task)).length === 0;
}

// ---------- 轮询主流程 ----------
export function startScavenger() {
  if (timer) return;
  console.log(`[scavenger] started poll=${POLL_BASE_MS}±${POLL_JITTER_MS}ms`);
  timer = setInterval(tick, TICK_MS);
}
export function stopScavenger() { if (timer) clearInterval(timer); timer = null; }

async function tick() {
  const now = Date.now();
  for (const task of listActiveTasks()) {
    // 时段已过(结束时刻+1h 宽限): 自动结束
    if (beijingMs(task.date, task.endMin) + 3600000 < now) {
      task.stats.endedReason = "时段已过自动结束";
      updateTaskRow(task.id, { status: "completed", stats: task.stats });
      nextPollAt.delete(task.id);
      continue;
    }
    const due = nextPollAt.get(task.id) || 0;
    if (now < due || inFlight.has(task.id)) continue;
    inFlight.add(task.id);
    nextPollAt.set(task.id, now + POLL_BASE_MS + Math.floor(Math.random() * (POLL_JITTER_MS + 1)));
    pollTask(task).catch((error) => console.warn(`[scavenger] task=${task.id} ${String(error?.message || error)}`)).finally(() => inFlight.delete(task.id));
  }
}

async function pollTask(task) {
  const now = Date.now();
  const stats = task.stats || {};
  stats.checks = (stats.checks || 0) + 1;
  stats.lastCheckAt = new Date(now).toISOString();
  let bookings = task.bookings;
  let covered = coveredOf(task);
  let status = task.status;
  for (const venueId of task.venueIds) {
    let uncovered = subtractIntervals([task.startMin, task.endMin], covered);
    if (!uncovered.length) { status = "completed"; break; }
    const venue = getVenue(venueId);
    if (!venue || typeof venue.listSlots !== "function") { stats.venueErrors = { ...(stats.venueErrors || {}), [venueId]: "场地不支持查询" }; continue; }
    // 支付优先级: 主支付 + 备选支付(主支付失败如余额不足时, 自动换备选支付重下同一批场次)
    const wechatFirst = task.payKind === "wechat-first";
    const payCodes = {
      primary: venue.payments?.[wechatFirst ? "wechat" : "balance"],
      fallback: venue.payments?.[wechatFirst ? "balance" : "wechat"],
    };
    if (payCodes.primary == null && payCodes.fallback == null) { stats.venueErrors = { ...(stats.venueErrors || {}), [venueId]: "不支持任何支付方式" }; continue; }
    const credential = getCredential(venueId, task.userId);
    if (!credential) { stats.venueErrors = { ...(stats.venueErrors || {}), [venueId]: "未配置凭证" }; continue; }
    let slots;
    try { slots = await venue.listSlots({ date: task.date }, credential); }
    catch (error) { stats.venueErrors = { ...(stats.venueErrors || {}), [venueId]: String(error?.message || error).slice(0, 120) }; continue; }
    delete (stats.venueErrors || {})[venueId];
    // 待支付订单释放检测: 未付款订单的场次重新可约 = 订单已释放, 撤销其覆盖让任务继续搜索
    for (let i = 0; i < bookings.length; i++) {
      const booking = bookings[i];
      if (booking.venueId !== venueId || booking.paid || booking.released || !booking.requiresManualPayment) continue;
      if (targetSlotsAvailable(booking.target, slots)) {
        bookings = bookings.map((b, index) => index === i ? { ...b, released: true, releasedAt: new Date(now).toISOString() } : b);
        console.log(`[scavenger] task=${task.id} 未支付订单已释放: ${booking.orderId}`);
      }
    }
    covered = coveredOf({ ...task, bookings });
    uncovered = subtractIntervals([task.startMin, task.endMin], covered);
    // 归一化并过滤: 可约 + 在未覆盖区间内 + 退款约束
    const ctx = {
      slotMinutes: venue.meta?.raw?.bookingHours?.slotMinutes, startMin: task.startMin,
      crossOvernight: task.crossOvernight, date: task.date,
      nonRefundableHours: venue.meta?.raw?.refundPolicy?.nonRefundableHours, now,
    };
    const avail = [];
    for (const slot of slots) {
      const parsed = normalizeSlot(slot, ctx);
      if (!parsed || !parsed.available || parsed.cost <= 0) continue;
      if (!task.allowNonrefundable && parsed.nonRefundable) continue;
      if (!uncovered.some(([u1, u2]) => parsed.beginMin >= u1 && parsed.endMin <= u2)) continue;
      avail.push(parsed);
    }
    // 逐个未覆盖区间尝试下单(先铺满, 铺不满且允许部分则订最长连续段)
    for (const [u1, u2] of uncovered) {
      const spent = bookings.filter((b) => !b.released).reduce((sum, b) => sum + (b.cost || 0), 0);
      const budget = task.maxTotalCost - spent;
      const candidates = findCandidates(avail, u1, u2, task.allowCombine, budget);
      const pick = candidates.full || (task.allowPartial ? candidates.partial : null);
      if (!pick) continue;
      // 关键流程日志: 发现可约场次(每次轮询静默, 仅在真正有机会时输出)
      console.log(`[scavenger] task=${task.id} ${venue.meta.name} 发现可约${candidates.full ? "" : "(部分)"}: ${pick.chain.map((s) => `${s.court} ${s.time}`).join(" + ")} ¥${pick.chain.reduce((sum, x) => sum + x.cost, 0)}`);
      const outcome = await bookSlots(task, venue, credential, pick.chain, payCodes, stats);
      if (outcome) {
        bookings = [...bookings, outcome.booking];
        covered = coveredOf({ ...task, bookings });
        console.log(`[scavenger] task=${task.id} 捡漏成功 ${venue.meta.name} ${outcome.booking.timeRange} ¥${outcome.booking.cost} orderId=${outcome.booking.orderId}`);
        if (fullyCovered({ ...task, bookings })) { status = "completed"; stats.endedReason = "时段已全部订满"; break; }
      }
    }
    if (status === "completed") break;
  }
  if (status === "completed") stats.endedReason = stats.endedReason || "时段已全部订满";
  updateTaskRow(task.id, { status: status === "active" ? undefined : status, bookings, stats });
}

// 下单(走限流队列, 与普通抢订共用 店铺+凭证 scope 正确互斥); 失败只记录不通知
// 支付优先级: 先用主支付下单, 失败(如余额不足/时段刚被占走前的支付类失败)自动换备选支付重下同一批场次
async function bookSlots(task, venue, credential, chain, payCodes, stats) {
  const totalCost = chain.reduce((sum, x) => sum + x.cost, 0);
  const base = venue.riskProfile || {};
  const profile = { ...base, scopeKey: `${base.scopeKey || venue.meta.id}:${task.userId}` };
  const buildTarget = (payCode) => ({
    date: task.date,
    courts: chain.map((s) => ({ court: s.court, courtUid: s.uid, time: s.time, cost: s.cost })),
    ext: { payMethod: payCode, totalCost },
  });
  // 支付语义名(码→balance/wechat), 日志与消息用
  const payName = (code) => (code != null && code === venue.payments?.balance ? "balance" : code === venue.payments?.wechat ? "wechat" : String(code));
  const dispatch = async (payCode, via) => {
    try {
      return await enqueueBooking(venue.meta.id, profile, async () => {
        console.log(`[scavenger] task=${task.id} dispatch ${venue.meta.name} ${chain.map((s) => `${s.court} ${s.time}`).join(" + ")} via=${via}`);
        return venue.grab(buildTarget(payCode), credential);
      });
    } catch (error) { return { success: false, message: String(error?.message || error) }; }
  };
  let result = await dispatch(payCodes.primary, payName(payCodes.primary));
  let switchedPay = false;
  // 主支付失败(余额不足等支付侧原因)且备选支付可用 → 自动切换重下(同 slot, 微信锁场等待人工付款)
  const primaryClass = (typeof venue.classifyGrabResult === "function" ? venue.classifyGrabResult(result) : classifyResult(result)) || "terminal";
  if (result?.success !== true && payCodes.fallback != null && primaryClass !== "rate-limited" && primaryClass !== "success") {
    console.log(`[scavenger] task=${task.id} ${payName(payCodes.primary)} 下单失败(${String(result?.message || "").slice(0, 60)}), 切换 ${payName(payCodes.fallback)} 重试`);
    const retry = await dispatch(payCodes.fallback, payName(payCodes.fallback));
    if (retry?.success === true) {
      switchedPay = true;
      result = retry;
    }
  }
  const classification = (typeof venue.classifyGrabResult === "function" ? venue.classifyGrabResult(result) : classifyResult(result)) || "terminal";
  stats.attempts = (stats.attempts || 0) + 1;
  try { // 审计入 job_attempts, 与普通任务共用排查入口
    db.prepare("INSERT INTO job_attempts(job_id,attempt,planned_at,dispatched_at,drift_ms,scope_key,classification,duration_ms,message) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(`scavenge:${task.id}`, stats.attempts, null, new Date().toISOString(), null, base.scopeKey || venue.meta.id, classification, 0, String(result?.message || "").slice(0, 500));
  } catch {}
  if (result?.success !== true) {
    stats.failures = (stats.failures || 0) + 1;
    stats.lastError = String(result?.message || "").slice(0, 200);
    stats.lastErrorAt = new Date().toISOString();
    // 关键流程日志: 最终下单失败(两种支付都试过)
    console.warn(`[scavenger] task=${task.id} 下单失败 ${venue.meta.name} ${chain.map((s) => `${s.court} ${s.time}`).join(" + ")}: ${String(result?.message || "").slice(0, 80)}`);
    if (classification === "rate-limited") applyCooldown(profile.scopeKey, 10000);
    return null;
  }
  const timeRange = `${chain[0].time}-${String(Math.floor(chain[chain.length - 1].endMin / 60)).padStart(2, "0")}:${String(chain[chain.length - 1].endMin % 60).padStart(2, "0")}`;
  const booking = {
    venueId: venue.meta.id, venueName: venue.meta.name,
    courts: chain.map((s) => ({ court: s.court, time: s.time })),
    startMin: chain[0].beginMin, endMin: chain[chain.length - 1].endMin, timeRange,
    cost: totalCost, orderId: result.orderId || null, message: result.message || "",
    requiresManualPayment: result.requiresManualPayment === true,
    paid: result.requiresManualPayment !== true,
    target, raw: result.raw || null,
    createdAt: new Date().toISOString(),
  };
  // 成功才通知(模板字段复用普通任务: thing2=场地/phrase5=结果/amount21=金额; 微信支付任务 outcome 自动为"待本人付款")
  const switchNote = switchedPay ? "（主支付失败已自动切换支付方式）" : "";
  const pendingHint = result.requiresManualPayment === true
    ? `捡漏锁场成功 ${venue.meta.name} ${timeRange}${switchNote}，请尽快完成微信支付（本小程序订单页或场馆小程序待付订单均可补付），超时订单释放后将自动继续捡漏`
    : `捡漏成功 ${venue.meta.name} ${timeRange}${switchNote}`;
  notifyJobResult({ userId: task.userId, venueId: venue.meta.id, target, status: "done", result: { ...result, message: pendingHint } })
    .catch((error) => console.warn("[scavenger-notify]", String(error?.message || error)));
  return { booking };
}

// 待支付订单标记已付(API 层调用)
export function confirmScavengePayment(taskId, userId, index) {
  const task = getScavengeTask(taskId, userId);
  if (!task) return { error: "not found" };
  const booking = task.bookings[Number(index)];
  if (!booking) return { error: "订单不存在" };
  if (booking.paid) return { error: "该订单已支付" };
  if (booking.released) return { error: "该订单已释放, 无需支付" };
  task.bookings[index] = { ...booking, paid: true, paidAt: new Date().toISOString() };
  updateTaskRow(task.id, { bookings: task.bookings });
  return { task: getScavengeTask(taskId, userId) };
}
