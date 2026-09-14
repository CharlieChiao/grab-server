export const FAILURE_KINDS = Object.freeze({
  SUCCESS: "success",
  RATE_LIMITED: "rate_limited",
  NOT_RELEASED: "not_released",
  UNAVAILABLE: "unavailable",
  OCCUPIED: "occupied",
  SCHEDULED: "scheduled",
  LOCKED: "locked",
  TRANSIENT: "transient",
  PAYMENT: "payment",
  UNKNOWN: "unknown",
});

const CLASSIFICATION_BY_KIND = Object.freeze({
  success: "success",
  rate_limited: "rate-limited",
  not_released: "not-released",
  unavailable: "terminal",
  occupied: "terminal",
  scheduled: "terminal",
  locked: "terminal",
  transient: "transient",
  payment: "terminal",
  unknown: "terminal",
});

const TERMINAL_KINDS = new Set(["occupied", "scheduled", "locked", "payment", "unknown"]);

function resultText(input) {
  if (typeof input === "string") return input;
  try { return JSON.stringify(input || {}); } catch { return String(input?.message || ""); }
}

function providerCodes(input) {
  if (!input || typeof input !== "object") return [];
  return [input.code, input.errorCode, input.status, input.raw?.code, input.raw?.errorCode, input.raw?.status]
    .filter((value) => value !== undefined && value !== null)
    .map(String);
}

function matches(rule, input, text) {
  if (Array.isArray(rule.slotStatuses) && rule.slotStatuses.map(String).includes(String(input?.slotStatus || input?.status || ""))) return true;
  const codes = providerCodes(input);
  if (Array.isArray(rule.codes) && rule.codes.map(String).some((code) => codes.includes(code))) return true;
  return (rule.patterns || []).some((pattern) => pattern instanceof RegExp ? pattern.test(text) : text.includes(String(pattern)));
}

export function normalizeFailure(kind, rule = {}, message = "") {
  const normalizedKind = kind || FAILURE_KINDS.UNKNOWN;
  const classification = rule.classification || CLASSIFICATION_BY_KIND[normalizedKind] || "terminal";
  const retryable = rule.retryable ?? ["rate-limited", "not-released", "release-pending", "transient"].includes(classification);
  return {
    kind: normalizedKind,
    classification,
    retryable,
    terminal: rule.terminal ?? (!retryable && TERMINAL_KINDS.has(normalizedKind)),
    inspectSlots: rule.inspectSlots === true,
    message: String(message || ""),
  };
}

/**
 * Declarative venue capability. Rules may match provider codes, slot statuses,
 * or provider-specific response text. The core consumes only normalized JSON.
 */
export function validateFailureReasons(declaration) {
  if (!declaration || !Array.isArray(declaration.rules) || declaration.rules.length === 0) throw new Error("failureReasons.rules must be a non-empty array");
  const kinds = new Set(Object.values(FAILURE_KINDS));
  for (const [index, rule] of declaration.rules.entries()) {
    if (!kinds.has(rule?.kind)) throw new Error(`failureReasons.rules[${index}].kind is invalid`);
    const hasMatcher = [rule.patterns, rule.codes, rule.slotStatuses].some((value) => Array.isArray(value) && value.length > 0);
    if (!hasMatcher) throw new Error(`failureReasons.rules[${index}] must declare patterns, codes, or slotStatuses`);
  }
  return declaration;
}

export function createFailureCapability(declaration = {}, legacyClassifier) {
  validateFailureReasons(declaration);
  const rules = declaration.rules;

  function classify(input) {
    if (input?.success === true) return normalizeFailure(FAILURE_KINDS.SUCCESS, { retryable: false, terminal: false }, input?.message);
    if (input?.failure?.kind) return normalizeFailure(input.failure.kind, input.failure, input.failure.message || input?.message);
    const text = resultText(input);
    for (const rule of rules) {
      if (matches(rule, input, text)) return normalizeFailure(rule.kind, rule, input?.message || text);
    }
    if (typeof legacyClassifier === "function") {
      const classification = legacyClassifier(input) || "terminal";
      return normalizeFailure(declaration.defaultKind || FAILURE_KINDS.UNKNOWN, { classification }, input?.message || text);
    }
    return normalizeFailure(declaration.defaultKind || FAILURE_KINDS.UNKNOWN, declaration.default || {}, input?.message || text);
  }

  function decorate(result) {
    if (!result || typeof result !== "object" || result.success === true) return result;
    return { ...result, failure: classify(result) };
  }

  return { classify, decorate };
}
