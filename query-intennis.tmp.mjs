import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/grab.sqlite");
const sessionId = "2741e298-4aab-45cc-9bb9-21293f836471";
const events = db.prepare("SELECT stage, safe_json FROM venue_discovery_events WHERE session_id=? ORDER BY id").all(sessionId);
console.log("total events:", events.length);
const byStage = {};
for (const row of events) {
  const safe = JSON.parse(row.safe_json);
  byStage[row.stage] = (byStage[row.stage] || 0) + 1;
  const endpoint = safe.endpoint || {};
  const url = (endpoint.baseUrl || "") + (endpoint.path || "");
  const headers = Object.keys((safe.event && safe.event.requestHeaders) || {});
  console.log(`[${row.stage}] ${safe.event?.method || endpoint.method} ${url} status=${safe.event?.statusCode}`);
  console.log(`    headers: ${headers.join(", ").slice(0, 150)}`);
  const body = safe.event?.requestBody;
  if (body && typeof body === "object") console.log("    bodyKeys:", Object.keys(body).join(", ").slice(0, 150));
}
console.log("--- stage counts:", JSON.stringify(byStage));
const creds = db.prepare("SELECT user_id, venue_id, updated_at, ready_ok FROM credentials").all();
console.log("--- credentials:", JSON.stringify(creds, null, 1));
