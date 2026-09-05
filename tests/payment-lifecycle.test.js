import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grab-payment-"));
process.env.GRAB_DB_FILE = path.join(tempDir, "payment.sqlite");
const jobs = await import("../src/core/jobStore.js");
const payments = await import("../src/core/paymentLifecycle.js");
const { db } = await import("../src/core/database.js");

function delegatedWechatJob() {
  return jobs.createJob({ userId: "owner", createdByUserId: "delegate", delegationId: "delegation", venueId: "picklepop", target: { date: "2099-01-01", court: "A", time: "19:00", ext: { payMethod: 900 } } });
}

test("delegated WeChat booking remains active while awaiting payment", () => {
  const job = delegatedWechatJob();
  assert.equal(payments.requiresWechatPayment(job, { success: true, orderId: "order-1" }), true);
  const waiting = payments.markAwaitingPayment(job, { success: true, orderId: "order-1" }, 321, 1_000_000);
  assert.equal(waiting.status, "awaiting_payment");
  assert.equal(waiting.result.paymentTimeoutMinutes, 15);
  assert.equal(jobs.listJobs().some((item) => item.id === job.id), true);
  assert.equal(jobs.listHistoryForUser("owner").length, 0);
});

test("slot availability fallback only matches the booked court and time", () => {
  const target = { date: "2099-01-01", courtUid: "court-a", time: "19:00" };
  assert.equal(payments.targetSlotsAvailable(target, [{ uid: "court-a", begin: "2099-01-01 19:00:00", canAppoint: true }]), true);
  assert.equal(payments.targetSlotsAvailable(target, [{ uid: "court-a", begin: "2099-01-01 20:00:00", canAppoint: true }]), false);
  assert.equal(payments.targetSlotsAvailable(target, [{ uid: "court-a", begin: "2099-01-01 19:00:00", canAppoint: false }]), false);
});

test("unpaid booking becomes payment-timeout history after its deadline", () => {
  const waiting = jobs.listJobs().find((item) => item.status === "awaiting_payment");
  payments.expireAwaitingPayments(Date.parse(waiting.result.paymentExpiresAt));
  assert.equal(jobs.listJobs().some((item) => item.id === waiting.id), false);
  const archived = jobs.listHistoryForUser("owner").find((item) => item.id === waiting.id);
  assert.equal(archived.status, "failed");
  assert.equal(archived.result.paymentStatus, "timeout");
  assert.match(archived.result.message, /实际等待 15 分钟/);
  assert.equal(archived.result.paymentElapsedMinutes, 15);
});

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.GRAB_DB_FILE;
});