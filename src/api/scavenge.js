/**
 * 捡漏任务 API — 多球场持续轮询可约场次并自动下单
 * POST /api/scavenge          创建 { venueIds, date, startTime, endTime, allowCombine, allowPartial, allowNonrefundable, maxTotalCost, payKind }
 *   注: payKind 仅支持 balance —— 微信支付的下单参数(script/prepay)时效短且无法凭 orderId 补付,
 *   无人值守捡漏场景下微信订单只能锁场无法完成付款, 故禁用。
 * GET  /api/scavenge          列表(含球场选项/凭证状态, 供创建表单)
 * DELETE /api/scavenge/:id    停止任务(保留记录)
 * POST /api/scavenge/:id/bookings/:index/payment-confirmed  确认微信支付完成(遗留通道, 新任务不再产生微信订单)
 */
import express from "express";
import { db } from "../core/database.js";
import { getVenue, listVenues } from "../core/venueRegistry.js";
import { createScavengeTask, getScavengeTask, listScavengeTasks, stopScavengeTask, confirmScavengePayment, hhmmToMinutes, mergeIntervals, subtractIntervals } from "../core/scavenger.js";
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
    id: task.id, venueIds: task.venueIds, date: task.date, startTime: task.startTime, endTime: task.endTime,
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
    return {
      id: venue.id, name: venue.name, logo: venue.logo || "",
      payments: adapter?.payments || null,
      credentialReady: cred ? cred.ready_ok === 1 : null,
    };
  });
}

router.get("/", (req, res) => {
  res.json({ ok: true, tasks: listScavengeTasks(req.user.id).map(presentTask), venueOptions: venueOptions(req.user.id) });
});

router.post("/", (req, res) => {
  const { venueIds, date, startTime, endTime, allowCombine, allowPartial, allowNonrefundable, maxTotalCost, payKind } = req.body || {};
  if (!Array.isArray(venueIds) || !venueIds.length) return res.status(400).json({ error: "请至少选择一个球场" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return res.status(400).json({ error: "日期格式无效" });
  const startMin = hhmmToMinutes(startTime), endMin = hhmmToMinutes(endTime);
  if (startMin == null || endMin == null) return res.status(400).json({ error: "时间格式无效(HH:MM)" });
  if (endMin === startMin) return res.status(400).json({ error: "结束时间需晚于开始时间" });
  if (!["balance"].includes(payKind)) return res.status(400).json({ error: "捡漏任务仅支持余额支付：微信支付参数时效短且无法凭订单号补付，无人值守场景下只能锁场无法完成付款" });
  const cost = Number(maxTotalCost);
  if (!Number.isFinite(cost) || cost <= 0) return res.status(400).json({ error: "最高接受价格无效" });
  // 日期窗口: 不早于今天(北京), 最多提前 14 天
  const bjToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const diffDays = Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(bjToday + "T00:00:00Z")) / 86400000);
  if (diffDays < 0) return res.status(400).json({ error: "日期不能早于今天" });
  if (diffDays > 14) return res.status(400).json({ error: "最多提前 14 天" });
  // 球场校验: 存在 + 支持 listSlots + 支持所选支付方式
  const unsupported = [];
  for (const venueId of [...new Set(venueIds)]) {
    const venue = getVenue(venueId);
    if (!venue || typeof venue.listSlots !== "function") unsupported.push(`${venueId}(不支持查询)`);
    else if (venue.payments?.[payKind] == null) unsupported.push(`${venue.name}(不支持${payKind === "wechat" ? "微信" : "余额"}支付)`);
  }
  if (unsupported.length) return res.status(400).json({ error: "以下球场不可用: " + unsupported.join("、") });
  const task = createScavengeTask(req.user.id, {
    venueIds: [...new Set(venueIds)], date, startTime, endTime,
    allowCombine: allowCombine !== false, allowPartial: allowPartial !== false, allowNonrefundable: allowNonrefundable !== false,
    maxTotalCost: cost, payKind,
  });
  res.json({ ok: true, task: presentTask(task) });
});

router.delete("/:id", (req, res) => {
  const task = stopScavengeTask(req.params.id, req.user.id);
  if (!task) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, task: presentTask(task) });
});

router.post("/:id/bookings/:index/payment-confirmed", (req, res) => {
  const result = confirmScavengePayment(req.params.id, req.user.id, req.params.index);
  if (result.error) return res.status(result.error === "not found" ? 404 : 400).json({ error: result.error });
  res.json({ ok: true, task: presentTask(result.task) });
});

export default router;
