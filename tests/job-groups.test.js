import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grab-groups-"));
process.env.GRAB_DB_FILE = path.join(tempDir, "groups.sqlite");
const groups = await import("../src/core/jobGroups.js");
const jobs = await import("../src/core/jobStore.js");
const { db } = await import("../src/core/database.js");

test("group exposes a stable uid and all-success aggregate", () => {
  const group = groups.createJobGroup("creator-a", { name: "周三晚场", successPolicy: "all" });
  assert.ok(group.uid);
  const first = jobs.createJob({ userId: "creator-a", venueId: "picklepop", groupUid: group.uid, target: { date: "2099-01-07", court: "A", time: "19:00" }, fireAt: "2099-01-01T04:00:00.000Z" });
  const second = jobs.createJob({ userId: "principal-b", createdByUserId: "creator-a", delegationId: "delegation-b", venueId: "picklepop", groupUid: group.uid, target: { date: "2099-01-07", court: "B", time: "20:00" }, fireAt: "2099-01-01T04:00:00.000Z" });
  jobs.updateJob(first.id, { status: "done", result: { success: true } }); jobs.archiveJob(first.id);
  jobs.updateJob(second.id, { status: "failed", result: { success: false } }); jobs.archiveJob(second.id);
  groups.finalizeAndRepeatGroup(group.uid);
  const result = groups.getJobGroup(group.uid, "creator-a");
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.summary, { total: 2, pending: 0, running: 0, awaiting_payment: 0, done: 1, failed: 1 });
});

test("only any-success groups stop pending siblings", () => {
  const anyGroup = groups.createJobGroup("creator-any", { name: "任一成功", successPolicy: "any" });
  const anyWinner = jobs.createJob({ userId: "creator-any", venueId: "picklepop", groupUid: anyGroup.uid, target: { date: "2099-03-01", court: "A", time: "19:00" } });
  const anySibling = jobs.createJob({ userId: "creator-any", venueId: "picklepop", groupUid: anyGroup.uid, target: { date: "2099-03-01", court: "B", time: "20:00" } });
  jobs.updateJob(anyWinner.id, { status: "done", result: { success: true } });
  jobs.archiveJob(anyWinner.id);
  const stopped = groups.stopPendingSiblingsAfterAnySuccess(anyGroup.uid, anyWinner.id);
  assert.deepEqual(stopped.map((job) => job.id), [anySibling.id]);
  assert.equal(jobs.listJobs().some((job) => job.id === anySibling.id), false);
  assert.equal(jobs.listHistoryForUser("creator-any").find((job) => job.id === anySibling.id).status, "stopped");

  const allGroup = groups.createJobGroup("creator-all", { name: "全部成功", successPolicy: "all" });
  const allWinner = jobs.createJob({ userId: "creator-all", venueId: "picklepop", groupUid: allGroup.uid, target: { date: "2099-03-02", court: "A", time: "19:00" } });
  const allSibling = jobs.createJob({ userId: "creator-all", venueId: "picklepop", groupUid: allGroup.uid, target: { date: "2099-03-02", court: "B", time: "20:00" } });
  jobs.updateJob(allWinner.id, { status: "done", result: { success: true } });
  jobs.archiveJob(allWinner.id);
  assert.deepEqual(groups.stopPendingSiblingsAfterAnySuccess(allGroup.uid, allWinner.id), []);
  assert.equal(jobs.listJobs().find((job) => job.id === allSibling.id).status, "pending");
});

test("weekly group creates one next occurrence and shifts dates by seven days", () => {
  const group = groups.createJobGroup("creator-c", { name: "每周固定场", successPolicy: "any", repeatWeekly: true });
  const job = jobs.createJob({ userId: "creator-c", venueId: "picklepop", groupUid: group.uid, target: { date: "2099-02-04", court: "A", time: "19:00" }, fireAt: "2099-01-29T04:00:00.000Z" });
  jobs.updateJob(job.id, { status: "done", result: { success: true } }); jobs.archiveJob(job.id);
  const nextUid = groups.finalizeAndRepeatGroup(group.uid);
  assert.ok(nextUid);
  assert.equal(groups.finalizeAndRepeatGroup(group.uid), null);
  const next = jobs.listJobs().find((item) => item.groupUid === nextUid);
  assert.equal(next.target.date, "2099-02-11");
  assert.equal(next.fireAt, "2099-02-05T04:00:00.000Z");
  assert.equal(groups.getJobGroup(nextUid, "creator-c").iteration, 2);
});

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.GRAB_DB_FILE;
});
