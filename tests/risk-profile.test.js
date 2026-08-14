import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getRiskProfile, recordRiskEvent, riskProfilePath } from "../src/core/riskProfile.js";
import { enqueueBooking, resetLimiterState } from "../src/core/requestLimiter.js";
test.after(() => fs.writeFileSync(riskProfilePath(), "{}", "utf8"));

test("risk profile increases interval after rate limiting", () => {
  fs.writeFileSync(riskProfilePath(), "{}", "utf8");
  const before = getRiskProfile("test-venue");
  const after = recordRiskEvent("test-venue", "rate-limited");
  assert.ok(after.booking.minIntervalMs > before.booking.minIntervalMs);
  assert.equal(after.stats.rateLimited, 1);
});

test("booking requests are serialized per venue", async () => {
  resetLimiterState();
  const events = [];
  const first = enqueueBooking("serial-test", { booking: { minIntervalMs: 0, jitterMs: 0 } }, async () => {
    events.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push("first-end");
    return 1;
  });
  const second = enqueueBooking("serial-test", { booking: { minIntervalMs: 0, jitterMs: 0 } }, async () => {
    events.push("second-start");
    events.push("second-end");
    return 2;
  });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events.slice(0, 3), ["first-start", "first-end", "second-start"]);
});



import { classifyResult, linearRetryDelay } from "../src/core/scheduler.js";

test("scheduler classifies release and rate-limit responses", () => {
  assert.equal(classifyResult({ success: false, message: "尚未放场" }), "not-released");
  assert.equal(classifyResult({ success: false, message: "操作太频繁！" }), "rate-limited");
  assert.equal(classifyResult({ success: false, message: "该时段不可约" }), "terminal");
  assert.equal(classifyResult({ success: true }), "success");
});

test("retry delay is linear configuration, not exponential", () => {
  const profile = { booking: { minIntervalMs: 3000, notReleasedIntervalMs: 3000, transientIntervalMs: 2000, cooldownMs: 10000, jitterMs: 0 } };
  assert.equal(linearRetryDelay(profile, "not-released"), 3000);
  assert.equal(linearRetryDelay(profile, "transient"), 2000);
  assert.equal(linearRetryDelay(profile, "rate-limited"), 10000);
});

test("different venues sharing a scope key are serialized", async () => {
  resetLimiterState();
  const events = [];
  const profile = { scopeKey: "provider:store:1", booking: { minIntervalMs: 0, jitterMs: 0 } };
  const first = enqueueBooking("venue-a", profile, async () => { events.push("a-start"); await new Promise((resolve) => setTimeout(resolve, 10)); events.push("a-end"); });
  const second = enqueueBooking("venue-b", profile, async () => { events.push("b-start"); });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a-start", "a-end", "b-start"]);
});
