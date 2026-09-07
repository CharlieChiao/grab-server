import express from "express";
import { db } from "../core/database.js";
import { listJobsForUser, listHistoryForUser, getJob, createJob, deleteJob, editJob } from "../core/jobStore.js";
import { getVenue } from "../core/venueRegistry.js";
import { autoFireAt } from "../core/timeUtil.js";
import { getActiveDelegation, paymentTypeFromCode } from "../core/delegations.js";
import { requireWritableGroup } from "../core/jobGroups.js";
import { expireAwaitingPayments, finishPayment } from "../core/paymentLifecycle.js";

const router = express.Router();

function paymentParams(job) {
  let script = job?.result?.raw?.result?.script; // 银豹: raw.result.script
  if (!script) script = job?.result?.raw?.data?.result?.jsConfig; // CRMEB: raw.data.result.jsConfig
  if (typeof script === "string") {
    try { script = JSON.parse(script); } catch {
      const field = (name) => {
        const match = new RegExp(name + "\\s*[:=]\\s*[\"']([^\"']+)[\"']", "i").exec(script);
        return match ? match[1] : "";
      };
      script = { timeStamp: field("timeStamp") || field("timestamp"), nonceStr: field("nonceStr"), package: field("package"), signType: field("signType"), paySign: field("paySign") };
    }
  }
  if (!script || typeof script !== "object") return null;
  const value = script.payParams || script.payment || script;
  const timeStamp = String(value.timeStamp || value.timestamp || "");
  const nonceStr = String(value.nonceStr || "");
  const packageValue = String(value.package || value.packageValue || "");
  const paySign = String(value.paySign || "");
  if (!timeStamp || !nonceStr || !packageValue || !paySign) return null;
  return { timeStamp, nonceStr, package: packageValue, signType: String(value.signType || "MD5"), paySign };
}
function presentJob(job, requesterId) {
  if (!job) return null;
  const delegatedManual = job.status === "awaiting_payment"; // awaiting 状态即表示需本人人工支付(委托与非委托均适用)
  const owner = job.userId === requesterId;
  const copy = { ...job, result: job.result ? { ...job.result } : null, paymentRequired: !!delegatedManual, canPay: false };
  if (copy.result) delete copy.result.raw;
  if (delegatedManual && owner) {
    const params = paymentParams(job);
    copy.paymentParams = params;
    copy.canPay = !!params;
  }
  return copy;
}

function validateTarget(target) {
  if (!target || typeof target !== "object") return "target is required";
  if (!target.date) return "target.date is required";
  const single = !!(target.court || target.courtUid);
  const multi = Array.isArray(target.courts) && target.courts.length > 0;
  if (!single && !multi) return "target.court or target.courts is required";
  if (single && multi) return "target.court and target.courts cannot both exist";
  if (single && !target.time) return "target.time is required";
  if (multi) {
    for (const [i, c] of target.courts.entries()) {
      if (typeof c === "string") {
        if (!target.time) return "target.courts[" + i + "] requires target.time";
      } else if (c && typeof c === "object") {
        if (!c.court && !c.courtUid) return "target.courts[" + i + "].court or .courtUid is required";
        if (!c.time && !target.time) return "target.courts[" + i + "].time or target.time is required";
      } else {
        return "target.courts[" + i + "] is invalid";
      }
    }
  }
  return null;
}

router.post("/", (req, res) => {
  const { venueId, target, fireAt, fireImmediately, principalUserId, groupUid } = req.body || {};
  if (!venueId) return res.status(400).json({ error: "venueId is required" });
  const venue = getVenue(venueId);
  if (!venue) return res.status(400).json({ error: "unknown venue: " + venueId });
  const err = validateTarget(target);
  if (err) return res.status(400).json({ error: err });
  // 可订范围校验(bookableDays): 部分球场浏览范围大于可订范围(如 In Tennis 会员分级), 提前拦截无效任务
  const bookableDays = Number(venue.meta?.bookableDays);
  if (Number.isFinite(bookableDays) && bookableDays > 0) {
    const bjToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const diffDays = Math.round((Date.parse(target.date + "T00:00:00Z") - Date.parse(bjToday + "T00:00:00Z")) / 86400000);
    if (diffDays > bookableDays) return res.status(400).json({ error: `超出最大可预定范围(最多提前 ${bookableDays} 天), 该日期仅可查看预约情况` });
  }

  let finalFireAt;
  let fireAtSource;
  if (fireImmediately === true) {
    finalFireAt = null;
    fireAtSource = "immediate";
  } else if (fireAt != null && fireAt !== "") {
    finalFireAt = fireAt;
    fireAtSource = "client";
  } else {
    try {
      finalFireAt = autoFireAt(venue.meta, target);
      fireAtSource = "auto";
    } catch (e) {
      return res.status(400).json({ error: "cannot calculate fireAt: " + e.message });
    }
  }
  let ownerUserId = req.user.id, delegationId = null;
  if (principalUserId && principalUserId !== req.user.id) {
    const delegation = getActiveDelegation(principalUserId, req.user.id);
    if (!delegation) return res.status(403).json({ error: "代理授权不存在或已过期" });
    const paymentType = paymentTypeFromCode(venueId, target?.ext?.payMethod);
    let allowedPayments = [];
    try { allowedPayments = JSON.parse(delegation.allowed_payments_json); } catch {}
    if (!paymentType || !allowedPayments.includes(paymentType)) return res.status(403).json({ error: "授权方未允许该支付方式" });
    ownerUserId = principalUserId;
    delegationId = delegation.id;
  }
  if (groupUid) {
    try { requireWritableGroup(groupUid, req.user.id); }
    catch (error) { return res.status(error.statusCode || 400).json({ error: String(error.message || error) }); }
  }
  const job = createJob({ userId: ownerUserId, createdByUserId: req.user.id, delegationId, groupUid: groupUid || null, venueId, target, fireAt: finalFireAt });
  res.json({ ok: true, job, fireAtSource });
});

// 定场人(owner)资料映射: 头像走稳定 URL(image 标签可缓存, 轮询重渲染不闪烁), v 参数在换头像后破缓存
// avatar(data URI)为旧版前端兼容字段, 小程序发版后可移除
function collectOwners(jobs) {
  const owners = {};
  for (const job of jobs) {
    const userId = job.userId;
    if (!userId || owners[userId]) continue;
    const row = db.prepare("SELECT nickname, avatar_mime, avatar_data, profile_updated_at FROM users WHERE id=?").get(userId);
    const version = row?.profile_updated_at ? Date.parse(row.profile_updated_at) : 0;
    owners[userId] = {
      nickname: row?.nickname || "微信用户",
      avatarUrl: row?.avatar_data ? `/api/users/${userId}/avatar?v=${version}` : null,
      avatar: row?.avatar_data ? `data:${row.avatar_mime || "image/jpeg"};base64,${Buffer.from(row.avatar_data).toString("base64")}` : "",
    };
  }
  return owners;
}

router.get("/", (req, res) => {
  const jobs = listJobsForUser(req.user.id).map((job) => presentJob(job, req.user.id));
  res.json({ ok: true, jobs, owners: collectOwners(jobs) });
});
router.get("/history", (req, res) => {
  const jobs = listHistoryForUser(req.user.id).map((job) => presentJob(job, req.user.id));
  res.json({ ok: true, jobs, owners: collectOwners(jobs) });
});
router.get("/:id", (req, res) => {
  const job = getJob(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const presented = presentJob(job, req.user.id);
  res.json({ ok: true, job: presented, owners: collectOwners([presented]) });
});
router.post("/:id/payment-confirmed", (req, res) => {
  expireAwaitingPayments().catch(() => {});
  const job = getJob(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (job.userId !== req.user.id) return res.status(403).json({ error: "微信付款必须由授权用户本人完成" });
  if (job.status !== "awaiting_payment") return res.status(409).json({ error: "订单当前不是待支付状态" });
  const completed = finishPayment(job.id);
  res.json({ ok: true, job: presentJob(completed, req.user.id) });
});
router.put("/:id", (req, res) => {
  const { fireAt, cost } = req.body || {};
  const result = editJob(req.params.id, req.user.id, { fireAt, cost });
  if (result.error) return res.status(result.error === "not found" ? 404 : 400).json({ error: result.error });
  res.json({ ok: true, job: presentJob(result.job, req.user.id) });
});
router.delete("/:id", (req, res) => res.json({ ok: deleteJob(req.params.id, req.user.id) }));

export default router;
