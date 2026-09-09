/**
 * 捡漏任务 API — 多球场持续轮询可约场次并自动下单
 * POST /api/scavenge          创建 { venueIds, date, startTime, endTime, allowCombine, allowPartial, allowNonrefundable, maxTotalCost, payKind }
 *   微信支付(payKind=wechat)语义: 下单成功即锁场并通知用户待支付; 用户可在本小程序(下单瞬间的支付参数,
 *   时效内有效)或场馆小程序的待付订单中补付; 超时释放后自动撤销覆盖继续捡漏。
 * GET  /api/scavenge          列表(含球场选项/凭证状态, 供创建表单)
 * DELETE /api/scavenge/:id    停止任务(保留记录)
 * POST /api/scavenge/:id/bookings/:index/payment-confirmed  确认微信支付完成
 */
import express from "express";
import { db } from "../core/database.js";
import { getVenue, listVenues } from "../core/venueRegistry.js";
import { createScavengeTask, getScavengeTask, listScavengeTasks, listArchivedScavengeTasks, stopScavengeTask, deleteScavengeTask, restartScavengeTask, archiveScavengeTask, updateScavengeTask, confirmScavengePayment, hhmmToMinutes, mergeIntervals, subtractIntervals } from "../core/scavenger.js";
import { collectOwners } from "./jobs.js";
import { courtTypeLabel, COURT_TYPES } from "../core/courtTypes.js";

// 校验 courtTypes: 非空, 且每个选中场馆至少支持其中一种类型(否则该场馆永远订不到, 提前拦截)
function validateCourtTypes(venueIds, courtTypes) {
  const list = [...new Set((courtTypes || []).map(String).filter(Boolean))];
  if (!list.length) return { error: "必须至少选择一种场地类型" };
  for (const venueId of [...new Set(venueIds || [])]) {
    const venue = getVenue(venueId);
    const types = new Set((venue?.meta?.courts || []).map((c) => c.type).filter(Boolean));
    if (!list.some((t) => types.has(t))) {
      return { error: `${venue?.name || venueId} 没有${list.map((t) => courtTypeLabel(t) || t).join("/")}场地, 请取消该球场或调整类型` };
    }
  }
  return { list };
}
import { paymentParams } from "./jobs.js";

const router = express.Router();

function presentBooking(booking) {
  const copy = { ...booking };
  delete copy.raw; // 支付参数提取后不再下发原始响应
  delete copy.target;
  if (!booking.paid && !booking.released && booking.requiresManualPayment) {
    const params = paymentParams({ result: { raw: booking.raw } });
    copy.paymentParams = params;
    copy.canPay = !!params;
  }
  return copy;
}
function presentTask(task) {
  const bookings = (task.bookings || []).map(presentBooking);
  const covered = mergeIntervals(bookings.filter((b) => !b.released).map((b) => [b.startMin, b.endMin]));
  const coveredMinutes = covered.reduce((sum, [s, e]) => sum + (e - s), 0);
  const totalMinutes = task.endMin - task.startMin;
  const spent = bookings.filter((b) => !b.released).reduce((sum, b) => sum + (b.cost || 0), 0);
  return {
    id: task.id, userId: task.userId, venueIds: task.venueIds, date: task.date, startTime: task.startTime, endTime: task.endTime,
    courtTypes: task.courtTypes, courtTypeLabel: task.courtTypes.map((t) => courtTypeLabel(t) || t).join("+"),
    allowCombine: task.allowCombine, allowPartial: task.allowPartial, allowNonrefundable: task.allowNonrefundable,
    maxTotalCost: task.maxTotalCost, payKind: task.payKind, status: task.status, stats: task.stats,
    createdAt: task.createdAt, updatedAt: task.updatedAt, bookings,
    spent, remainingBudget: Math.max(0, task.maxTotalCost - spent),
    coveredMinutes, totalMinutes, progress: `${coveredMinutes}/${totalMinutes} 分钟`,
    pendingPayments: bookings.filter((b) => !b.paid && !b.released && b.requiresManualPayment).length,
  };
}
function venueOptions(userId) {
  return listVenues().map((venue) => {
    const adapter = getVenue(venue.id);
    const cred = db.prepare("SELECT ready_ok FROM credentials WHERE user_id=? AND venue_id=?").get(userId, venue.id);
    // 场地类型经适配器契约 courtUidsForType 探测: 类型 → uid 列表非空即支持; 无 courts 声明的球场 courtTypes 为空(前端变灰)
    const courtTypes = Object.keys(COURT_TYPES).filter((t) => (adapter?.courtUidsForType?.(t) || []).length > 0);
    return {
      id: venue.id, name: venue.name, logo: venue.logo || "",
      payments: adapter?.payments || null,
      credentialReady: cred ? cred.ready_ok === 1 : null,
      courtTypes: courtTypes.map((t) => ({ value: t, label: courtTypeLabel(t) })),
    };
  });
}

// 类型选项(所有球场类型并集, 带标签) — 前端唯一类型数据来源, 不再本地维护映射
function allCourtTypeOptions() {
  const types = [...new Set(listVenues().flatMap((v) => Object.keys(COURT_TYPES).filter((t) => (getVenue(v.id)?.courtUidsForType?.(t) || []).length > 0)))];
  return types.map((t) => ({ value: t, label: courtTypeLabel(t) }));
}

router.get("/", (req, res) => {
  const tasks = listScavengeTasks(req.user.id);
  const archived = listArchivedScavengeTasks(req.user.id);
  const all = [...tasks, ...archived];
  res.json({ ok: true, tasks: tasks.map(presentTask), archivedTasks: archived.map(presentTask), venueOptions: venueOptions(req.user.id), courtTypeOptions: allCourtTypeOptions(), owners: collectOwners(all) });
});

router.post("/", (req, res) => {
  const { venueIds, date, startTime, endTime, courtTypes, allowCombine, allowPartial, allowNonrefundable, maxTotalCost, payKind } = req.body || {};
  const typeCheck = validateCourtTypes(venueIds, courtTypes);
  if (typeCheck.error) return res.status(400).json({ error: typeCheck.error });
  if (!Array.isArray(venueIds) || !venueIds.length) return res.status(400).json({ error: "请至少选择一个球场" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return res.status(400).json({ error: "日期格式无效" });
  const startMin = hhmmToMinutes(startTime), endMin = hhmmToMinutes(endTime);
  if (startMin == null || endMin == null) return res.status(400).json({ error: "时间格式无效(HH:MM)" });
  if (endMin === startMin) return res.status(400).json({ error: "结束时间需晚于开始时间" });
  // 支付优先级: balance-first(余额优先,不足自动切换微信锁场) / wechat-first; 兼容旧单值 balance/wechat
  const normalizedPay = payKind === "wechat-first" || payKind === "wechat" ? "wechat-first" : payKind === "balance-first" || payKind === "balance" ? "balance-first" : null;
  if (!normalizedPay) return res.status(400).json({ error: "支付方式无效" });
  const cost = Number(maxTotalCost);
  if (!Number.isFinite(cost) || cost <= 0) return res.status(400).json({ error: "最高接受价格无效" });
  // 日期窗口: 不早于今天(北京), 最多提前 14 天
  const bjToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const diffDays = Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(bjToday + "T00:00:00Z")) / 86400000);
  if (diffDays < 0) return res.status(400).json({ error: "日期不能早于今天" });
  if (diffDays > 14) return res.status(400).json({ error: "最多提前 14 天" });
  // 球场校验: 存在 + 支持 listSlots + 至少支持优先级里的一种支付(主支付缺失时用备选)
  const primaryKind = normalizedPay === "wechat-first" ? "wechat" : "balance";
  const fallbackKind = normalizedPay === "wechat-first" ? "balance" : "wechat";
  const unsupported = [];
  for (const venueId of [...new Set(venueIds)]) {
    const venue = getVenue(venueId);
    if (!venue || typeof venue.listSlots !== "function") unsupported.push(`${venueId}(不支持查询)`);
    else if (venue.payments?.[primaryKind] == null && venue.payments?.[fallbackKind] == null) unsupported.push(`${venue.name}(不支持任何支付方式)`);
  }
  if (unsupported.length) return res.status(400).json({ error: "以下球场不可用: " + unsupported.join("、") });
  const created = createScavengeTask(req.user.id, {
    venueIds: [...new Set(venueIds)], date, startTime, endTime, courtTypes: typeCheck.list,
    allowCombine: allowCombine !== false, allowPartial: allowPartial !== false, allowNonrefundable: allowNonrefundable !== false,
    maxTotalCost: cost, payKind: normalizedPay,
  });
  if (created?.error) return res.status(400).json({ error: created.error });
  res.json({ ok: true, task: presentTask(created) });
});

// 停止进行中的捡漏任务(保留记录)
router.post("/:id/stop", (req, res) => {
  const task = stopScavengeTask(req.params.id, req.user.id);
  if (!task) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, task: presentTask(task) });
});

// 删除捡漏任务(仅非进行中)
router.delete("/:id", (req, res) => {
  const result = deleteScavengeTask(req.params.id, req.user.id);
  if (result.error) return res.status(result.error === "not found" ? 404 : 400).json({ error: result.error });
  res.json({ ok: true });
});

// 重新开始已停止的捡漏任务
router.post("/:id/restart", (req, res) => {
  const result = restartScavengeTask(req.params.id, req.user.id);
  if (result.error) return res.status(result.error === "not found" ? 404 : 400).json({ error: result.error });
  res.json({ ok: true, task: presentTask(result.task) });
});

// 归档捡漏任务(移入历史区)
router.post("/:id/archive", (req, res) => {
  const result = archiveScavengeTask(req.params.id, req.user.id);
  if (result.error) return res.status(result.error === "not found" ? 404 : 400).json({ error: result.error });
  res.json({ ok: true });
});

// 编辑进行中的捡漏任务(时段/规则/预算/支付优先级/场地类型)
router.put("/:id", (req, res) => {
  const body = req.body || {};
  const row = db.prepare("SELECT venue_ids_json FROM scavenge_tasks WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (row && body.courtTypes !== undefined) {
    let vids = [];
    try { vids = JSON.parse(row.venue_ids_json || "[]"); } catch {}
    const typeCheck = validateCourtTypes(vids, body.courtTypes);
    if (typeCheck.error) return res.status(400).json({ error: typeCheck.error });
    body = { ...body, courtTypes: typeCheck.list };
  }
  const result = updateScavengeTask(req.params.id, req.user.id, body);
  if (result.error) return res.status(result.error === "not found" ? 404 : 400).json({ error: result.error });
  res.json({ ok: true, task: presentTask(result.task) });
});

router.post("/:id/bookings/:index/payment-confirmed", (req, res) => {
  const result = confirmScavengePayment(req.params.id, req.user.id, req.params.index);
  if (result.error) return res.status(result.error === "not found" ? 404 : 400).json({ error: result.error });
  res.json({ ok: true, task: presentTask(result.task) });
});

export default router;
