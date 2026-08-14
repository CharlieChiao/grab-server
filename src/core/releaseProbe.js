import crypto from "node:crypto";
import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const clamp = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

function classify(venue, result) {
  const text = JSON.stringify(result || {}).toLowerCase();
  if (result?.success) return "success";
  if (/\u64cd\u4f5c\u592a\u9891\u7e41|\u64cd\u4f5c\u9891\u7e41|429|too frequent|rate limit/i.test(text)) return "rate-limited";
  if (typeof venue.classifyGrabResult === "function") return venue.classifyGrabResult(result);
  return "terminal";
}

export async function runManualReleaseProbe({ venueId, userId, target, startDelayMs, stepMs, maxAttempts }) {
  const venue = getVenue(venueId);
  if (!venue) throw new Error("unknown venue");
  if (!target?.date || !(target.court || target.courtUid) || !target.time) throw new Error("single court, date and time are required");
  const credential = getCredential(venueId, userId);
  if (!credential) throw new Error("credential missing");
  if (typeof venue.buildGrabRequest !== "function" || typeof venue.fireGrab !== "function") throw new Error("venue does not support manual release probe");

  const normalized = {
    date: target.date,
    court: target.court,
    courtUid: target.courtUid,
    time: target.time,
    cost: Number(target.cost),
    ext: { ...(target.ext || {}), payMethod: 900, totalCost: Number(target.cost) },
  };
  if (!Number.isFinite(normalized.cost) || normalized.cost <= 0) throw new Error("valid cost is required");
  const initial = clamp(startDelayMs, 10, 10, 5000);
  const step = clamp(stepMs, 500, 50, 10000);
  const tries = Math.floor(clamp(maxAttempts, 6, 1, 12));
  const probeId = crypto.randomUUID();
  const attempts = [];
  const started = Date.now();
  const prebuilt = venue.buildGrabRequest(normalized, credential);

  for (let attempt = 1; attempt <= tries; attempt++) {
    const plannedOffsetMs = initial + (attempt - 1) * step;
    await sleep(started + plannedOffsetMs - Date.now());
    const dispatchedAt = Date.now();
    let result;
    try { result = await venue.fireGrab(prebuilt); }
    catch (error) { result = { success: false, message: String(error?.message || error) }; }
    const classification = classify(venue, result);
    attempts.push({ attempt, plannedOffsetMs, dispatchedOffsetMs: dispatchedAt - started, classification, success: !!result?.success, message: String(result?.message || "").slice(0, 300), orderId: result?.orderId || null });
    if (result?.success) return { ok: true, probeId, createdUnpaidOrder: true, payMethod: 900, firstSuccessOffsetMs: dispatchedAt - started, orderId: result.orderId || null, attempts, message: "First successful attempt created one unpaid order. Release it in the venue mini program when finished." };
    if (classification === "rate-limited") return { ok: false, probeId, stopped: "rate-limited", attempts, message: "Stopped after the venue reported too-frequent activity; no additional attempts were sent." };
  }
  return { ok: false, probeId, stopped: "attempt-limit", attempts, message: "No order was created before the manual attempt limit." };
}
