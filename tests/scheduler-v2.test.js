import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import yaml from "js-yaml";
import { computeReleaseTimeUTC, autoFireAt } from "../src/core/timeUtil.js";
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

test("scheduler no longer gates dispatch on listSlots", () => {
  const source = fs.readFileSync(new URL("../src/core/scheduler.js", import.meta.url), "utf8");
  assert.equal(source.includes("targetIsReleased"), false);
  assert.equal(source.includes("updateJob(job.id, { status: \"pending\", fireAt"), false);
  assert.equal(source.includes("[dispatch]"), true);
});