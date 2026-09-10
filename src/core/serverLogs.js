const BUSINESS_MODULES = new Set([
  "scavenger", "grab", "dispatch", "schedule", "watch", "payment-expire", "payment-poll",
]);

function messageBody(line) {
  const match = String(line).match(/^\d{4}-\d{2}-\d{2}T\S+\s+\S+\s+[^:]+:\s?(.*)$/);
  return match ? match[1] : String(line);
}

export function filterBusinessLogs(stdout) {
  let includeContinuation = false;
  return String(stdout || "").split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    const body = messageBody(line);
    const tag = body.match(/^\[([^\]]+)\]/);
    if (tag) {
      includeContinuation = BUSINESS_MODULES.has(tag[1].split(":")[0]);
      return includeContinuation;
    }
    const continuation = includeContinuation && (/^\s+(?:at\b|\.\.\.)/.test(body) || /^\(Use\b/.test(body));
    if (!continuation) includeContinuation = false;
    return continuation;
  }).join("\n");
}

export function prepareLogPayload(stdout, { business = false, lines = 300, maxBytes = 96 * 1024 } = {}) {
  const source = business ? filterBusinessLogs(stdout) : String(stdout || "");
  const allLines = source.split(/\r?\n/).filter((line) => line.trim());
  let selected = allLines.slice(-lines);
  let truncated = selected.length < allLines.length;
  while (selected.length && Buffer.byteLength(selected.join("\n"), "utf8") > maxBytes) {
    selected.shift();
    truncated = true;
  }
  const prefix = truncated ? "[日志过长，已仅保留末尾记录]\n" : "";
  return { logs: prefix + selected.join("\n"), truncated };
}
