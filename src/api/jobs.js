import express from "express";
import { listJobsForUser, getJob, createJob, deleteJob } from "../core/jobStore.js";
import { getVenue } from "../core/venueRegistry.js";
import { autoFireAt } from "../core/timeUtil.js";

const router = express.Router();

function validateTarget(target) {
  if (!target || typeof target !== "object") return "target is required";
  if (!target.date) return "target.date is required";
  const single = !!target.court;
  const multi = Array.isArray(target.courts) && target.courts.length > 0;
  if (!single && !multi) return "target.court or target.courts is required";
  if (single && multi) return "target.court and target.courts cannot both exist";
  if (single && !target.time) return "target.time is required";
  if (multi) {
    for (const [i, c] of target.courts.entries()) {
      if (typeof c === "string") {
        if (!target.time) return "target.courts[" + i + "] requires target.time";
      } else if (c && typeof c === "object") {
        if (!c.court) return "target.courts[" + i + "].court is required";
        if (!c.time && !target.time) return "target.courts[" + i + "].time or target.time is required";
      } else {
        return "target.courts[" + i + "] is invalid";
      }
    }
  }
  return null;
}

router.post("/", (req, res) => {
  const { venueId, target, fireAt, fireImmediately } = req.body || {};
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
  const job = createJob({ userId: req.user.id, venueId, target, fireAt: finalFireAt });
  res.json({ ok: true, job, fireAtSource });
});

router.get("/", (req, res) => res.json({ ok: true, jobs: listJobsForUser(req.user.id) }));
router.get("/:id", (req, res) => {
  const job = getJob(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, job });
});
router.delete("/:id", (req, res) => res.json({ ok: deleteJob(req.params.id, req.user.id) }));

export default router;
