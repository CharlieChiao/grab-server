import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grab-delegation-"));
process.env.GRAB_DB_FILE = path.join(tempDir, "delegation.sqlite");
const policy = await import("../src/core/delegations.js");
const { db } = await import("../src/core/database.js");

test("one-time invite requires its password and creates an expiring delegation", () => {
  const invite = policy.createDelegationInvite("owner-a", { validDays: 3, allowedPayments: ["balance", "wechat"] });
  assert.equal(invite.password.length, 6);
  assert.equal(policy.getInvitePreview(invite.token).validDays, 3);
  assert.throws(() => policy.acceptDelegationInvite(invite.token, "999999", "delegate-a"), /校验密码错误/);

  const accepted = policy.acceptDelegationInvite(invite.token, invite.password, "delegate-a");
  assert.equal(accepted.status, "active");
  assert.deepEqual(accepted.allowedPayments, ["balance", "wechat"]);
  assert.ok(Date.parse(accepted.validUntil) > Date.now());
  assert.equal(policy.getInvitePreview(invite.token), null);
  assert.ok(policy.getActiveDelegation("owner-a", "delegate-a"));
});

test("either side can revoke without a second password", () => {
  const invite = policy.createDelegationInvite("owner-b", { validDays: null, allowedPayments: ["wechat"] });
  const accepted = policy.acceptDelegationInvite(invite.token, invite.password, "delegate-b");
  assert.equal(accepted.unlimited, true);
  assert.equal(policy.revokeDelegation(accepted.id, "delegate-b"), true);
  assert.equal(policy.getActiveDelegation("owner-b", "delegate-b"), null);
});

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.GRAB_DB_FILE;
});
