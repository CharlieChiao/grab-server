import express from "express";
import { listJobsForUser, listHistoryForUser, getJob, createJob, deleteJob } from "../core/jobStore.js";
import { getVenue } from "../core/venueRegistry.js";
import { autoFireAt } from "../core/timeUtil.js";
import { getActiveDelegation, paymentTypeFromCode } from "../core/delegations.js";

const router = express.Router();

function paymentParams(job) {
  let script = job?.result?.raw?.result?.script;
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
  const delegatedWechat = job.delegated && Number(job.target?.ext?.payMethod) === 900 && job.result?.success;
  const owner = job.userId === requesterId;
  const copy = { ...job, result: job.result ? { ...job.result } : null, paymentRequired: !!delegatedWechat, canPay: false };
  if (copy.result) delete copy.result.raw;
  if (delegatedWechat && owner) {
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
  const { venueId, target, fireAt, fireImmediately, principalUserId } = req.body || {};
  if (!venueId) return res.status(400).json({ error: "venueId is required" });
  const venue = getVenue(venueId);
  if (!venue) return res.status(400).json({ error: "unknown venue: " + venueId });
  const err = validateTarget(target);
  if (err) return res.status(400).json({ error: err });

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
    const paymentType = paymentTypeFromCode(target?.ext?.payMethod);
    let allowedPayments = [];
    try { allowedPayments = JSON.parse(delegation.allowed_payments_json); } catch {}
    if (!paymentType || !allowedPayments.includes(paymentType)) return res.status(403).json({ error: "授权方未允许该支付方式" });
    ownerUserId = principalUserId;
    delegationId = delegation.id;
  }
  const job = createJob({ userId: ownerUserId, createdByUserId: req.user.id, delegationId, venueId, target, fireAt: finalFireAt });
  res.json({ ok: true, job, fireAtSource });
});

router.get("/", (req, res) => res.json({ ok: true, jobs: listJobsForUser(req.user.id).map((job) => presentJob(job, req.user.id)) }));
router.get("/history", (req, res) => res.json({ ok: true, jobs: listHistoryForUser(req.user.id).map((job) => presentJob(job, req.user.id)) }));
router.get("/:id", (req, res) => {
  const job = getJob(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, job: presentJob(job, req.user.id) });
});
router.delete("/:id", (req, res) => res.json({ ok: deleteJob(req.params.id, req.user.id) }));

export default router;
