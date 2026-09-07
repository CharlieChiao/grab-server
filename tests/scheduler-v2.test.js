import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import yaml from "js-yaml";
import { computeReleaseTimeUTC, autoFireAt } from "../src/core/timeUtil.js";
import { refineUnavailableReason } from "../src/core/scheduler.js";
import { db } from "../src/core/database.js";
const venueConfig = yaml.load(fs.readFileSync(new URL("../src/venues/picklepop/venue.yml", import.meta.url), "utf8"));

test("calendar-day release rules calculate exact Beijing wall time", () => {
  assert.equal(computeReleaseTimeUTC("2026-08-16", 2, "00:00:00.000").toISOString(), "2026-08-13T16:00:00.000Z");
  assert.equal(computeReleaseTimeUTC("2026-08-16", 1, "20:00:00.000").toISOString(), "2026-08-15T12:00:00.000Z");
  assert.equal(autoFireAt({ ...venueConfig, courts: venueConfig.courts }, { date: "2026-08-16", courtUid: "1762927653888739869" }), "2026-08-13T16:00:00.000Z");
});

test("dispatch audit schema exists", () => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='job_attempts'").get();
  assert.equal(row.name, "job_attempts");
});

test("unavailable booking failure is refined with slot-level reason", async () => {
  const mockVenue = {
    async listSlots() {
      return [
        { uid: "court-a", court: "1号", begin: "2026-09-09 19:00:00", canAppoint: false, message: "2026-09-09(周三) 19:00-19:59场次已被排课" },
        { uid: "court-a", court: "1号", begin: "2026-09-09 20:00:00", canAppoint: false, message: "2026-09-09(周三) 20:00-20:59场次已被预约" },
        { uid: "court-b", court: "2号", begin: "2026-09-09 19:00:00", canAppoint: true, message: "" },
      ];
    },
  };
  const job = { target: { date: "2026-09-09", courtUid: "court-a", time: "19:00" } };
  const reason = await refineUnavailableReason(mockVenue, job, {}, "该时段不可约");
  assert.equal(reason, "19:00已被排课");
  // 多时段任务收集全部原因
  const multi = { target: { date: "2026-09-09", courts: [{ courtUid: "court-a", time: "19:00" }, { courtUid: "court-a", time: "20:00" }] } };
  const multiReason = await refineUnavailableReason(mockVenue, multi, {}, "该时段不可约");
  assert.equal(multiReason, "19:00已被排课、20:00已被预约");
  // 非"不可约"消息不触发回查
  assert.equal(await refineUnavailableReason(mockVenue, job, {}, "余额不足"), null);
});

test("scheduler no longer gates dispatch on listSlots", () => {
  const source = fs.readFileSync(new URL("../src/core/scheduler.js", import.meta.url), "utf8");
  assert.equal(source.includes("targetIsReleased"), false);
  assert.equal(source.includes("updateJob(job.id, { status: \"pending\", fireAt"), false);
  assert.equal(source.includes("[dispatch]"), true);
});

test("calibrated release interval is applied on the first scheduled attempt", () => {
  const source = fs.readFileSync(new URL("../src/core/scheduler.js", import.meta.url), "utf8");
  assert.equal(source.includes("attempt === 1 && !!job.fireAt && hasCalibratedReleaseInterval"), true);
  assert.equal(source.includes("hasCalibratedReleaseInterval ? releaseBaseInterval : fallbackReleaseInterval"), true);
  assert.equal(source.includes("releaseBaseInterval +"), false);
});
