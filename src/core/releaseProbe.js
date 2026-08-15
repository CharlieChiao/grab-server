import { getVenue } from "./venueRegistry.js";
import { getCredential } from "./credentialStore.js";
import { enqueueBooking } from "./requestLimiter.js";

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


function isUnavailable(result) {
  return /\u8be5\u65f6\u6bb5\u4e0d\u53ef\u7ea6|\u65e0\u6548\u65f6\u6bb5|\u5c1a\u672a\u653e\u573a|\u8fd8\u6ca1\u5f00\u573a|\u672a\u5f00\u653e/.test(String(result?.message || ""));
}

export async function calibrateUnavailableRetry({ venueId, userId, target, sampleCount, initialExtraWaitMs, stepMs, maxExtraWaitMs }) {
  const venue = getVenue(venueId);
  if (!venue || typeof venue.saveRetryCalibration !== "function") throw new Error("venue does not support retry calibration persistence");
  if (!target?.date || !(target.court || target.courtUid) || !target.time) throw new Error("single court, date and time are required");
  const credential = getCredential(venueId, userId);
  if (!credential) throw new Error("credential missing");
  const normalized = { date: target.date, court: target.court, courtUid: target.courtUid, time: target.time, cost: Number(target.cost), ext: { ...(target.ext || {}), payMethod: 900, totalCost: Number(target.cost) } };
  if (!Number.isFinite(normalized.cost) || normalized.cost <= 0) throw new Error("valid cost is required");
  const samples = Math.floor(clamp(sampleCount, 6, 3, 12));
  const step = clamp(stepMs, 50, 10, 500);
  const maxExtra = clamp(maxExtraWaitMs, 500, 0, 5000);
  let extra = clamp(initialExtraWaitMs, 0, 0, maxExtra);
  const allAttempts = [];
  const prebuilt = venue.buildGrabRequest(normalized, credential);

  for (; extra <= maxExtra; extra += step) {
    const candidate = [];
    let previousDispatch = null;
    let rateLimited = false;
    for (let index = 1; index <= samples; index++) {
      let dispatchedAt = null;
      let result;
      try {
        result = await enqueueBooking(venueId, venue.riskProfile || {}, async () => {
          dispatchedAt = Date.now();
          return venue.fireGrab(prebuilt);
        }, { minIntervalMs: index === samples ? 0 : extra, jitterMs: 0 });
      } catch (error) { result = { success: false, message: String(error?.message || error) }; }
      const classification = classify(venue, result);
      const row = { candidateExtraWaitMs: extra, sample: index, dispatchedAt: new Date(dispatchedAt || Date.now()).toISOString(), dispatchGapMs: previousDispatch == null || dispatchedAt == null ? null : dispatchedAt - previousDispatch, classification, message: String(result?.message || "").slice(0, 300) };
      previousDispatch = dispatchedAt || previousDispatch;
      candidate.push(row); allAttempts.push(row);
      if (result?.success) return { ok: false, stopped: "unexpected-success", createdUnpaidOrder: true, orderId: result.orderId || null, attempts: allAttempts, message: "Target became bookable; calibration stopped without saving. Release the unpaid order." };
      if (classification === "rate-limited") { rateLimited = true; break; }
      if (!isUnavailable(result)) return { ok: false, stopped: "unexpected-response", attempts: allAttempts, message: String(result?.message || "Unexpected response") };
    }
    if (!rateLimited && candidate.length === samples) {
      const observedGaps = candidate.map((row) => row.dispatchGapMs).filter(Number.isFinite);
      const saved = venue.saveRetryCalibration({ extraWaitMs: extra, sampleCount: samples, observedMinDispatchGapMs: observedGaps.length ? Math.min(...observedGaps) : null, observedMaxDispatchGapMs: observedGaps.length ? Math.max(...observedGaps) : null, calibratedAt: new Date().toISOString(), endpoint: "create-appointment", target: { courtUid: normalized.courtUid, date: normalized.date, time: normalized.time } });
      return { ok: true, safeExtraWaitMs: extra, attempts: allAttempts, saved, message: "Calibration saved. The release retry path now uses this extra wait plus jitter." };
    }
    await sleep(10000);
  }
  return { ok: false, stopped: "no-safe-interval", attempts: allAttempts, message: "No safe interval found within the configured maximum." };
}
