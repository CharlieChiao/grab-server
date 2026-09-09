import test from "node:test";
import assert from "node:assert/strict";
import { hhmmToMinutes, mergeIntervals, subtractIntervals, normalizeSlot, findCandidates } from "../src/core/scavenger.js";

const slot = (court, uid, begin, cost, extra = {}) => ({ court, uid, begin: `2026-09-10 ${begin}`, cost, canAppoint: true, ...extra });
// findCandidates 入参是 normalizeSlot 之后的形状
const nslot = (court, uid, hhmm, cost) => {
  const beginMin = hhmmToMinutes(hhmm);
  return { court, uid, beginMin, endMin: beginMin + 60, time: hhmm, cost, available: true, nonRefundable: false };
};

test("hhmm 解析与跨天语义", () => {
  assert.equal(hhmmToMinutes("18:00"), 1080);
  assert.equal(hhmmToMinutes("bad"), null);
});

test("区间合并与相减", () => {
  assert.deepEqual(mergeIntervals([[5, 10], [10, 15], [20, 25]]), [[5, 15], [20, 25]]);
  assert.deepEqual(subtractIntervals([0, 100], [[10, 20], [50, 60]]), [[0, 10], [20, 50], [60, 100]]);
  assert.deepEqual(subtractIntervals([0, 100], [[0, 100]]), []);
  assert.deepEqual(subtractIntervals([0, 100], []), [[0, 100]]);
});

test("normalizeSlot 统一时长并识别不可约/不可退款", () => {
  const ctx = { slotMinutes: 60, startMin: 1080, crossOvernight: false, date: "2026-09-10", nonRefundableHours: 24, now: Date.parse("2026-09-10T12:00:00+08:00") };
  const s = normalizeSlot(slot("1号", "1", "18:00", 60), ctx);
  assert.equal(s.beginMin, 1080);
  assert.equal(s.endMin, 1140); // 按 slotMinutes=60 推算, 忽略银豹 18:59 结束偏移
  assert.equal(s.available, true);
  assert.equal(s.nonRefundable, true); // 距开场 6h < 24h
  const s2 = normalizeSlot(slot("1号", "1", "18:00", 60, { canAppoint: false }), ctx);
  assert.equal(s2.available, false);
});

test("normalizeSlot 跨天任务把凌晨场次归到次日", () => {
  const ctx = { slotMinutes: 60, startMin: 22 * 60, crossOvernight: true, date: "2026-09-10", nonRefundableHours: 0, now: 0 };
  const s = normalizeSlot(slot("1号", "1", "01:00", 60), ctx);
  assert.equal(s.beginMin, 60 + 1440);
});

test("findCandidates 单场地铺满", () => {
  const slots = [nslot("1号", "1", "18:00", 30), nslot("1号", "1", "19:00", 30), nslot("2号", "2", "18:00", 50)];
  const { full } = findCandidates(slots, 1080, 1200, false, 999);
  assert.ok(full);
  assert.equal(full.chain.length, 2);
  assert.equal(full.chain[0].uid, "1");
  assert.equal(full.chain.reduce((s, x) => s + x.cost, 0), 60);
});

test("findCandidates 关闭组合时跨场地不能拼链, 开启后可以", () => {
  const slots = [nslot("1号", "1", "18:00", 30), nslot("3号", "3", "19:00", 30)];
  assert.equal(findCandidates(slots, 1080, 1200, false, 999).full, null);
  const combined = findCandidates(slots, 1080, 1200, true, 999).full;
  assert.ok(combined);
  assert.equal(combined.chain.map((s) => s.uid).join(","), "1,3");
});

test("findCandidates 预算不足时放弃铺满, 部分链在预算内选择", () => {
  const slots = [nslot("1号", "1", "18:00", 60), nslot("1号", "1", "19:00", 60), nslot("2号", "2", "18:00", 20)];
  assert.equal(findCandidates(slots, 1080, 1200, false, 50).full, null);
  const partial = findCandidates(slots, 1080, 1200, false, 50).partial;
  assert.ok(partial);
  assert.equal(partial.chain.length, 1);
  assert.equal(partial.chain[0].uid, "2"); // 1号(¥60)超预算, 选预算内的 2号(¥20)
});

test("findCandidates 只有部分可订时返回部分链", () => {
  const slots = [nslot("1号", "1", "19:00", 30)];
  const { full, partial } = findCandidates(slots, 1080, 1200, true, 999);
  assert.equal(full, null);
  assert.ok(partial);
  assert.equal(partial.chain[0].beginMin, 1140);
});

test("findCandidates 同价时单场地链优先于跨场地链", () => {
  const slots = [nslot("1号", "1", "18:00", 30), nslot("1号", "1", "19:00", 30), nslot("2号", "2", "18:00", 30), nslot("3号", "3", "19:00", 30)];
  const { full } = findCandidates(slots, 1080, 1200, true, 999);
  assert.equal(full.chain.every((s) => s.uid === full.chain[0].uid), true);
});
