/**
 * 定时任务 API
 *  POST   /api/jobs        创建定时任务
 *  GET    /api/jobs        查询所有定时任务
 *  GET    /api/jobs/:id    查询单个
 *  DELETE /api/jobs/:id    删除定时任务
 */
import express from "express";
import { listJobs, getJob, createJob, deleteJob } from "../core/jobStore.js";
import { getVenue } from "../core/venueRegistry.js";
import { autoFireAt } from "../core/timeUtil.js";

const router = express.Router();

/**
 * 校验 target 是否合法(支持单场地 court 或 多场地 courts[])
 * 返回错误消息字符串, 合法则返回 null
 */
function validateTarget(target) {
  if (!target || typeof target !== "object") return "target 必填";
  if (!target.date) return "target.date 必填 (YYYY-MM-DD)";

  const hasSingle = !!target.court;
  const hasMulti = Array.isArray(target.courts) && target.courts.length > 0;

  if (!hasSingle && !hasMulti) return "target.court 或 target.courts 至少提供一个";
  if (hasSingle && hasMulti) return "target.court 与 target.courts 不能同时存在";

  if (hasSingle) {
    if (!target.time) return "target.time 必填 (HH:mm)";
  } else {
    // 多场地: 每项要有 court, time 可在顶层或每项提供
    for (const [i, c] of target.courts.entries()) {
      if (typeof c === "string") {
        if (!target.time) return `target.courts[${i}] 为字符串时, 顶层 target.time 必填`;
      } else if (c && typeof c === "object") {
        if (!c.court) return `target.courts[${i}].court 必填`;
        if (!c.time && !target.time) return `target.courts[${i}].time 或顶层 target.time 必填`;
      } else {
        return `target.courts[${i}] 非法, 需为字符串或对象`;
      }
    }
  }
  return null;
}

// 创建
router.post("/", (req, res) => {
  const { venueId, target, fireAt, fireImmediately } = req.body || {};

  if (!venueId) return res.status(400).json({ error: "venueId 必填" });
  const venue = getVenue(venueId);
  if (!venue) return res.status(400).json({ error: "未知球场: " + venueId });

  const err = validateTarget(target);
  if (err) return res.status(400).json({ error: err });

  // fireAt 策略:
  //   1) fireImmediately === true  -> 立刻执行 (fireAt=null, 调度器识别为立即)
  //   2) 前端传了 fireAt            -> 尊重前端
  //   3) 都没有                     -> 按 advanceDays 自动算
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
      return res.status(400).json({ error: "无法自动计算开抢时刻: " + e.message });
    }
  }

  const job = createJob({ venueId, target, fireAt: finalFireAt });
  res.json({ ok: true, job, fireAtSource });
});

// 查询所有
router.get("/", (req, res) => {
  res.json({ ok: true, jobs: listJobs() });
});

// 查询单个
router.get("/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, job });
});

// 删除
router.delete("/:id", (req, res) => {
  const ok = deleteJob(req.params.id);
  res.json({ ok });
});

export default router;
