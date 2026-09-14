import test from "node:test";
import assert from "node:assert/strict";
import { createFailureCapability } from "../src/core/failureReasons.js";
import { createKeyedSingleFlight } from "../src/core/singleFlight.js";

test("failure reason declarations normalize provider responses", () => {
  const capability = createFailureCapability({ rules: [
    { kind: "occupied", terminal: true, slotStatuses: ["occupied"], patterns: [/booked/i] },
    { kind: "not_released", classification: "not-released", retryable: true, codes: ["NOT_OPEN"] },
    { kind: "unavailable", inspectSlots: true, patterns: [/unavailable/i] },
  ] });
  const occupied = capability.classify({ slotStatus: "occupied" });
  assert.equal(occupied.kind, "occupied");
  assert.equal(occupied.classification, "terminal");
  assert.equal(occupied.retryable, false);
  assert.equal(occupied.terminal, true);
  assert.equal(capability.classify({ raw: { code: "NOT_OPEN" } }).retryable, true);
  assert.equal(capability.classify({ message: "slot unavailable" }).inspectSlots, true);
  assert.equal(capability.decorate({ success: false, message: "booked" }).failure.kind, "occupied");
  assert.throws(() => createFailureCapability({ rules: [{ kind: "made_up", patterns: ["x"] }] }), /kind is invalid/);
});

test("keyed single-flight shares refresh only within one account", async () => {
  const run = createKeyedSingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const operation = async (value) => { calls++; await gate; return value; };
  const a1 = run("user-a", () => operation("token-a"));
  const a2 = run("user-a", () => operation("wrong-token"));
  const b = run("user-b", () => operation("token-b"));
  release();
  assert.deepEqual(await Promise.all([a1, a2, b]), ["token-a", "token-a", "token-b"]);
  assert.equal(calls, 2);
});
