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
import { createScavengeTask, getScavengeTask, listScavengeTasks, stopScavengeTask, updateScavengeTask, confirmScavengePayment, hhmmToMinutes, mergeIntervals, subtractIntervals } from "../core/scavenger.js";
import { collectOwners } from "./jobs.js";

// 场地类型中文标签(与 yml courts[].type 对应, 未登记的类型前端回退显示原值)
const COURT_TYPE_LABELS = { tennis: "网球", pickle: "匹克球", badminton: "羽毛球", basketball: "篮球", football: "足球", table_tennis: "乒乓球", snooker: "台球", swimming: "游泳" };
// 校验 courtType: 必须被所有选中场馆支持(任意场馆缺少该类型则拒绝)
function validateCourtType(venueIds, courtType) {
  if (!courtType) return null;
  for (const venueId of [...new Set(venueIds || [])]) {
    const venue = getVenue(venueId);
    const types = [...new Set((venue?.meta?.raw?.courts || []).map((c) => c.type).filter(Boolean))];
    if (!types.includes(courtType)) return `${venue?.name || venueId} 没有${COURT_TYPE_LABELS[courtType] || courtType}场地, 请重新选择球场或类型`;
  }
  return null;
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
    courtType: task.courtType || null, courtTypeLabel: COURT_TYPE_LABELS[task.courtType] || task.courtType || "不限",
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
    const courts = adapter?.meta?.raw?.courts || [];
    return {
      id: venue.id, name: venue.name, logo: venue.logo || "",
      payments: adapter?.payments || null,
      credentialReady: cred ? cred.ready_ok === 1 : null,
      courtTypes: [...new Set(courts.map((c) => c.type).filter(Boolean))],
    };
  });
}

router.get("/", (req, res) => {
  const tasks = listScavengeTasks(req.user.id);
  res.json({ ok: true, tasks: tasks.map(presentTask), venueOptions: venueOptions(req.user.id), owners: collectOwners(tasks) });
});

router.post("/", (req, res) => {
  const { venueIds, date, startTime, endTime, courtType, allowCombine, allowPartial, allowNonrefundable, maxTotalCost, payKind } = req.body || {};
  const courtTypeError = validateCourtType(venueIds, courtType || null);
  if (courtTypeError) return res.status(400).json({ error: courtTypeError });
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
    venueIds: [...new Set(venueIds)], date, startTime, endTime, courtType: courtType || null,
    allowCombine: allowCombine !== false, allowPartial: allowPartial !== false, allowNonrefundable: allowNonrefundable !== false,
    maxTotalCost: cost, payKind: normalizedPay,
  });
  if (created?.error) return res.status(400).json({ error: created.error });
  res.json({ ok: true, task: presentTask(created) });
});

router.delete("/:id", (req, res) => {
  const task = stopScavengeTask(req.params.id, req.user.id);
  if (!task) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, task: presentTask(task) });
});

// 编辑进行中的捡漏任务(时段/规则/预算/支付优先级/场地类型)
router.put("/:id", (req, res) => {
  const body = req.body || {};
  const row = db.prepare("SELECT venue_ids_json FROM scavenge_tasks WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (row && body.courtType !== undefined) {
    let vids = [];
    try { vids = JSON.parse(row.venue_ids_json || "[]"); } catch {}
    const courtTypeError = validateCourtType(vids, body.courtType || null);
    if (courtTypeError) return res.status(400).json({ error: courtTypeError });
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
