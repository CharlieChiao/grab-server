import test from "node:test";
import assert from "node:assert/strict";
import { extractCredentialsFromHar, pathMatches } from "../tools/telegram-bot.mjs";

const venues = [
  { id: "picklepop", name: "PICKLE POP", raw: { capture: { enabled: true, hosts: ["wxservice-stg48.pospal.cn"], paths: ["*"], headers: ["PSPLVISITORID"] } } },
  { id: "disabled-venue", name: "未启用", raw: { capture: { enabled: false, hosts: ["a.example.com"], headers: ["X"] } } },
];

function harEntry(url, headers) {
  return { request: { url, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } };
}

test("path matching supports wildcard and exact forms", () => {
  assert.equal(pathMatches("/wxapi/a", ["*"]), true);
  assert.equal(pathMatches("/wxapi/a", ["/wxapi/*"]), true);
  assert.equal(pathMatches("/other/a", ["/wxapi/*"]), false);
  assert.equal(pathMatches("/wxapi/a", ["/wxapi/a"]), true);
});

test("extracts credentials for configured venue from HAR entries", () => {
  const har = { log: { entries: [
    harEntry("https://imgw.pospal.cn/we/mini/image/logo.png", { PSPLVISITORID: "should-not-extract" }),
    harEntry("https://wxservice-stg48.pospal.cn/wxapi/store/GetStoreDataFast", { "Content-Type": "application/json", PSPLVISITORID: "  tg-test-visitor-id-0123456789  " }),
  ] } };
  const hits = extractCredentialsFromHar(har, venues);
  const hit = hits.find((item) => item.venueId === "picklepop");
  assert.ok(hit, "picklepop should match");
  assert.equal(hit.headers.PSPLVISITORID, "tg-test-visitor-id-0123456789");
});

test("returns empty when no configured host appears in HAR", () => {
  const har = { log: { entries: [harEntry("https://unknown.example.com/api", { PSPLVISITORID: "abcdef0123456789abcdef" })] } };
  assert.equal(extractCredentialsFromHar(har, venues).length, 0);
});

test("latest entry wins when multiple requests carry the credential", () => {
  const har = { log: { entries: [
    harEntry("https://wxservice-stg48.pospal.cn/wxapi/store/GetStoreDataFast", { PSPLVISITORID: "old-value-0123456789" }),
    harEntry("https://wxservice-stg48.pospal.cn/wxapi/store/GetStoreDataFast", { PSPLVISITORID: "new-value-0123456789" }),
  ] } };
  const hit = extractCredentialsFromHar(har, venues).find((item) => item.venueId === "picklepop");
  assert.equal(hit.headers.PSPLVISITORID, "new-value-0123456789");
});
