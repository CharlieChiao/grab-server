import test from "node:test";
import assert from "node:assert/strict";
import { filterBusinessLogs, prepareLogPayload } from "../src/core/serverLogs.js";

const line = (time, body) => `2026-09-10T${time}+08:00 host app[1]: ${body}`;

test("business log scope keeps booking modules and their stack continuations", () => {
  const input = [
    line("00:00:00", "[ready:api] funsport -> OK 已登录"),
    line("00:00:01", "[schedule] job=1 fireAt=now"),
    line("00:00:02", "[dispatch] job=1 attempt=1"),
    line("00:00:03", "[grab] Error: failed"),
    line("00:00:03", "    at run (/app/index.js:1:1)"),
    line("00:00:04", "[scavenger] task=2 捡漏成功"),
    line("00:00:05", "[server] listening on :3000"),
  ].join("\n");
  const logs = filterBusinessLogs(input);
  assert.match(logs, /\[schedule\]/);
  assert.match(logs, /\[dispatch\]/);
  assert.match(logs, /\[grab\]/);
  assert.match(logs, /at run/);
  assert.match(logs, /\[scavenger\]/);
  assert.doesNotMatch(logs, /\[ready:api\]/);
  assert.doesNotMatch(logs, /\[server\]/);
});

test("prepared payload limits business records and reports truncation", () => {
  const input = [
    line("00:00:00", "[scavenger] first"),
    line("00:00:01", "[ready:api] ignored"),
    line("00:00:02", "[grab] second"),
    line("00:00:03", "[dispatch] third"),
  ].join("\n");
  const result = prepareLogPayload(input, { business: true, lines: 2 });
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.logs, /first/);
  assert.match(result.logs, /second/);
  assert.match(result.logs, /third/);
});
