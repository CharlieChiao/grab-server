import test from "node:test";
import assert from "node:assert/strict";
import { legacyPayOrder, normalizePayOrder, payStepsForVenue, canSwitchPayment } from "../src/core/scavengePayments.js";
import { createFailureCapability } from "../src/core/failureReasons.js";
import { createScavengeTask, updateScavengeTask } from "../src/core/scavenger.js";
import { loadVenues } from "../src/core/venueRegistry.js";
import { db } from "../src/core/database.js";

test("mixed venues keep their supported methods in task priority order", () => {
  const order = ["timecard", "balance", "wechat"];
  assert.deepEqual(payStepsForVenue(order, { timecard: 220, balance: 1, wechat: 2 }).map((step) => step.kind), order);
  assert.deepEqual(payStepsForVenue(order, { wechat: "wechat" }).map((step) => step.kind), ["wechat"]);
  assert.deepEqual(payStepsForVenue(order, { balance: "yue", wechat: "wx" }).map((step) => step.kind), ["balance", "wechat"]);
});

test("legacy tasks retain their prior payment fallback order", () => {
  assert.deepEqual(legacyPayOrder("timecard-first"), ["timecard", "balance"]);
  assert.deepEqual(normalizePayOrder(null, "balance-first"), ["balance", "wechat"]);
  assert.equal(normalizePayOrder(["wechat", "wechat"]), null);
});

test("next payment is attempted only after declared payment failure", () => {
  const capability = createFailureCapability({ rules: [
    { kind: "occupied", patterns: [/occupied/] },
    { kind: "payment", patterns: [/balance insufficient/] },
    { kind: "transient", classification: "transient", retryable: true, patterns: [/timeout/] },
  ] });
  const venue = { classifyFailure: capability.classify };
  assert.equal(canSwitchPayment(venue, { success: false, message: "balance insufficient" }), true);
  assert.equal(canSwitchPayment(venue, { success: false, message: "occupied" }), false);
  assert.equal(canSwitchPayment(venue, { success: false, message: "timeout" }), false);
  assert.equal(canSwitchPayment(venue, { success: false, message: "unknown" }), false);
  assert.equal(canSwitchPayment(venue, { success: true }), false);
});


test("ordered methods survive task creation and edit across mixed venues", async () => {
  await loadVenues();
  const userId = "payment-order-contract-test";
  const created = createScavengeTask(userId, {
    venueIds: ["funsport", "no996"], date: "2026-10-01", startTime: "19:00", endTime: "21:00",
    courtTypes: ["tennis"], allowPartial: true, maxTotalCost: 500,
    payOrder: ["timecard", "balance", "wechat"], payKind: "timecard-first",
  });
  assert.ok(created?.id, created?.error);
  try {
    assert.deepEqual(created.payOrder, ["timecard", "balance", "wechat"]);
    assert.equal(created.endMin - created.startMin, 120);
    const changed = updateScavengeTask(created.id, userId, { payOrder: ["wechat", "balance"] });
    assert.deepEqual(changed.task.payOrder, ["wechat", "balance"]);
    assert.equal(changed.task.payKind, "wechat-first");
    assert.match(updateScavengeTask(created.id, userId, { payOrder: ["timecard"] }).error, /不支持所选支付方式.*No996/);
  } finally {
    db.prepare("DELETE FROM scavenge_tasks WHERE id=?").run(created.id);
  }
});
