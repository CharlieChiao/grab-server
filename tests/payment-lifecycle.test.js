import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grab-payment-"));
process.env.GRAB_DB_FILE = path.join(tempDir, "payment.sqlite");
const jobs = await import("../src/core/jobStore.js");
const payments = await import("../src/core/paymentLifecycle.js");
const groups = await import("../src/core/jobGroups.js");
const { db } = await import("../src/core/database.js");

function delegatedWechatJob() {
  return jobs.createJob({ userId: "owner", createdByUserId: "delegate", delegationId: "delegation", venueId: "picklepop", target: { date: "2099-01-01", court: "A", time: "19:00", ext: { payMethod: 900 } } });
}

test("delegated manual-payment booking remains active while awaiting payment", () => {
  const job = delegatedWechatJob();
  assert.equal(payments.requiresManualPayment(job, { success: true, orderId: "order-1", requiresManualPayment: true }), true);
  // 非委托(自己下单)的微信支付任务同样进入待支付窗口
  const own = jobs.createJob({ userId: "owner", createdByUserId: "owner", venueId: "picklepop", target: { date: "2099-01-01", court: "A", time: "19:00", ext: { payMethod: 900 } } });
  assert.equal(own.delegated, false);
  assert.equal(payments.requiresManualPayment(own, { success: true, orderId: "order-own", requiresManualPayment: true }), true);
  const waiting = payments.markAwaitingPayment(job, { success: true, orderId: "order-1", requiresManualPayment: true }, 321, 1_000_000);
  assert.equal(waiting.status, "awaiting_payment");
  assert.equal(waiting.result.paymentTimeoutMinutes, 15);
  assert.equal(jobs.listJobs().some((item) => item.id === job.id), true);
  assert.equal(jobs.listHistoryForUser("owner").length, 0);
});

test("awaiting payment stops no sibling, paid any-success job stops pending siblings", () => {
  const group = groups.createJobGroup("payment-group-user", { name: "微信支付任务组", successPolicy: "any" });
  const paying = jobs.createJob({ userId: "payment-group-user", venueId: "picklepop", groupUid: group.uid, target: { date: "2099-01-02", court: "A", time: "19:00", ext: { payMethod: 900 } } });
  const sibling = jobs.createJob({ userId: "payment-group-user", venueId: "picklepop", groupUid: group.uid, target: { date: "2099-01-02", court: "B", time: "20:00" } });
  payments.markAwaitingPayment(paying, { success: true, orderId: "order-group", requiresManualPayment: true }, 100, 3_000_000);
  assert.equal(jobs.listJobs().find((job) => job.id === sibling.id).status, "pending");

  payments.finishPayment(paying.id, 3_001_000);
  assert.equal(jobs.listJobs().some((job) => job.id === sibling.id), false);
  assert.equal(jobs.listHistoryForUser("payment-group-user").find((job) => job.id === sibling.id).status, "stopped");
  assert.equal(groups.getJobGroup(group.uid, "payment-group-user").outcome, "success");
});

test("slot availability fallback only matches the booked court and time", () => {
  const target = { date: "2099-01-01", courtUid: "court-a", time: "19:00" };
  assert.equal(payments.targetSlotsAvailable(target, [{ uid: "court-a", begin: "2099-01-01 19:00:00", canAppoint: true }]), true);
  assert.equal(payments.targetSlotsAvailable(target, [{ uid: "court-a", begin: "2099-01-01 20:00:00", canAppoint: true }]), false);
  assert.equal(payments.targetSlotsAvailable(target, [{ uid: "court-a", begin: "2099-01-01 19:00:00", canAppoint: false }]), false);
});

test("unpaid booking becomes payment-timeout history after its deadline", async () => {
  const waiting = jobs.listJobs().find((item) => item.status === "awaiting_payment");
  await payments.expireAwaitingPayments(Date.parse(waiting.result.paymentExpiresAt));
  assert.equal(jobs.listJobs().some((item) => item.id === waiting.id), false);
  const archived = jobs.listHistoryForUser("owner").find((item) => item.id === waiting.id);
  assert.equal(archived.status, "failed");
  assert.equal(archived.result.paymentStatus, "timeout");
  assert.match(archived.result.message, /实际等待 15 分 0 秒/);
  assert.equal(archived.result.paymentElapsedMs, 900000);
});

test("fallback switch reroutes timeout into balance booking attempt", async () => {
  const job = jobs.createJob({ userId: "owner", createdByUserId: "delegate", delegationId: "delegation", venueId: "picklepop", target: { date: "2099-01-01", court: "A", time: "19:00", ext: { payMethod: 900, fallbackBalance: true } } });
  payments.markAwaitingPayment(job, { success: true, orderId: "order-fb" }, 100, 2_000_000);
  const waiting = jobs.listJobs().find((item) => item.id === job.id && item.status === "awaiting_payment");
  await payments.expireAwaitingPayments(Date.parse(waiting.result.paymentExpiresAt));
  const archived = jobs.listHistoryForUser("owner").find((item) => item.id === job.id);
  assert.equal(archived.status, "failed");
  assert.equal(archived.result.paymentStatus, "fallback-failed");
  assert.match(archived.result.message, /余额兜底未成功: unknown venue: picklepop/);
});

test("released payment falls back from owner balance to creator balance and completes any-success group", async () => {
  const { loadVenues, getVenue } = await import("../src/core/venueRegistry.js");
  const { setCredential } = await import("../src/core/credentialStore.js");
  await loadVenues();
  const venue = getVenue("picklepop");
  assert.ok(venue);
  const attempts = [];
  venue.grab = async (_target, credential) => {
    attempts.push(credential.account);
    return credential.account === "owner"
      ? { success: false, message: "授权方余额不足" }
      : { success: true, orderId: "fallback-order", message: "创建者余额支付成功" };
  };

  const ownerUserId = "fallback-owner";
  const creatorUserId = "fallback-creator";
  setCredential("picklepop", { account: "owner" }, ownerUserId);
  setCredential("picklepop", { account: "creator" }, creatorUserId);
  const now = new Date().toISOString();
  const delegationId = "fallback-delegation";
  db.prepare("INSERT INTO delegations(id,owner_user_id,delegate_user_id,valid_until,allowed_payments_json,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)")
    .run(delegationId, ownerUserId, creatorUserId, null, JSON.stringify(["wechat", "balance"]), now, now);

  const group = groups.createJobGroup(creatorUserId, { name: "余额兜底组", successPolicy: "any" });
  const paying = jobs.createJob({ userId: ownerUserId, createdByUserId: creatorUserId, delegationId, venueId: "picklepop", groupUid: group.uid, target: { date: "2099-01-03", court: "A", time: "19:00", ext: { payMethod: 900, fallbackBalance: true } } });
  const sibling = jobs.createJob({ userId: creatorUserId, venueId: "picklepop", groupUid: group.uid, target: { date: "2099-01-03", court: "B", time: "20:00" } });
  payments.markAwaitingPayment(paying, { success: true, orderId: "wechat-order", requiresManualPayment: true }, 100, 4_000_000);

  const completed = await payments.fallbackBalanceBooking(jobs.listJobs().find((job) => job.id === paying.id), "场次已释放", 4_001_000);
  assert.deepEqual(attempts, ["owner", "creator"]);
  assert.equal(completed.status, "done");
  assert.equal(completed.result.success, true);
  assert.equal(completed.result.paymentStatus, "fallback-paid");
  assert.equal(completed.result.paymentFallbackBy, "creator");
  assert.equal(jobs.listHistoryForUser(creatorUserId).find((job) => job.id === sibling.id).status, "stopped");
  assert.equal(groups.getJobGroup(group.uid, creatorUserId).outcome, "success");
});

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.GRAB_DB_FILE;
});
