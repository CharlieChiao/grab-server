import express from "express";
import { createJobGroup, getJobGroup, listJobGroups, stopJobGroup, updateJobGroup } from "../core/jobGroups.js";

const router = express.Router();
router.get("/", (req, res) => res.json({ ok: true, groups: listJobGroups(req.user.id) }));
router.post("/", (req, res) => res.json({ ok: true, group: createJobGroup(req.user.id, req.body || {}) }));
router.get("/:uid", (req, res) => {
  const group = getJobGroup(req.params.uid, req.user.id);
  if (!group) return res.status(404).json({ error: "任务组不存在" });
  res.json({ ok: true, group });
});
router.put("/:uid", (req, res) => {
  try { res.json({ ok: true, group: updateJobGroup(req.params.uid, req.user.id, req.body || {}) }); }
  catch (error) { res.status(error.statusCode || 400).json({ error: String(error.message || error) }); }
});
router.delete("/:uid", (req, res) => res.json({ ok: stopJobGroup(req.params.uid, req.user.id) }));
export default router;