export const PAYMENT_KINDS = Object.freeze(["timecard", "balance", "wechat"]);

export function legacyPayOrder(payKind) {
  if (payKind === "timecard-first") return ["timecard", "balance"];
  if (payKind === "wechat-first" || payKind === "wechat") return ["wechat", "balance"];
  return ["balance", "wechat"];
}

export function normalizePayOrder(value, payKind = "balance-first") {
  if (value == null) return legacyPayOrder(payKind);
  if (!Array.isArray(value) || !value.length || value.some((kind) => !PAYMENT_KINDS.includes(kind))) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value];
}

export function payStepsForVenue(order, payments) {
  return (order || []).filter((kind) => payments?.[kind] != null).map((kind) => ({ kind, code: payments[kind] }));
}

export function canSwitchPayment(venue, result) {
  const failure = typeof venue?.classifyFailure === "function" ? venue.classifyFailure(result) : result?.failure;
  return result?.success !== true && failure?.kind === "payment";
}
