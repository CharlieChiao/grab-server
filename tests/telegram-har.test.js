import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grab-tg-"));
process.env.GRAB_DB_FILE = path.join(tempDir, "tg.sqlite");
const { loadVenues } = await import("../src/core/venueRegistry.js");
await loadVenues();
const { extractCredentialsFromHar } = await import("../src/core/telegramBot.js");

function harEntry(url, headers) {
  return { request: { url, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } };
}

test("extracts credentials for configured venue from HAR entries", () => {
  const har = { log: { entries: [
    harEntry("https://imgw.pospal.cn/we/mini/image/logo.png", { PSPLVISITORID: "should-not-extract" }),
    harEntry("https://wxservice-stg48.pospal.cn/wxapi/store/GetStoreDataFast", { "Content-Type": "application/json", PSPLVISITORID: "  tg-test-visitor-id-0123456789  " }),
  ] } };
  const hits = extractCredentialsFromHar(har);
  const hit = hits.find((item) => item.venueId === "picklepop");
  assert.ok(hit, "picklepop should match");
  assert.equal(hit.headers.PSPLVISITORID, "tg-test-visitor-id-0123456789");
});

test("returns empty when no configured host appears in HAR", () => {
  const har = { log: { entries: [harEntry("https://unknown.example.com/api", { PSPLVISITORID: "abcdef0123456789abcdef" })] } };
  assert.equal(extractCredentialsFromHar(har).length, 0);
});

test("latest entry wins when multiple requests carry the credential", () => {
  const har = { log: { entries: [
    harEntry("https://wxservice-stg48.pospal.cn/wxapi/store/GetStoreDataFast", { PSPLVISITORID: "old-value-0123456789" }),
    harEntry("https://wxservice-stg48.pospal.cn/wxapi/store/GetStoreDataFast", { PSPLVISITORID: "new-value-0123456789" }),
  ] } };
  const hit = extractCredentialsFromHar(har).find((item) => item.venueId === "picklepop");
  assert.equal(hit.headers.PSPLVISITORID, "new-value-0123456789");
});

test.after(async () => {
  const { db } = await import("../src/core/database.js");
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.GRAB_DB_FILE;
});
