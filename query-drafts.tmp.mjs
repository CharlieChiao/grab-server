import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/grab.sqlite");
const drafts = db.prepare("SELECT id, venue_name, status, created_at, updated_at, manifest_json FROM venue_discovery_drafts ORDER BY updated_at DESC LIMIT 3").all();
for (const draft of drafts) {
  const manifest = JSON.parse(draft.manifest_json || "{}");
  console.log("=== draft:", draft.venue_name, "status:", draft.status, "at", draft.updated_at);
  console.log("    activation:", manifest.activation, "missing:", JSON.stringify(manifest.missing || []));
  for (const [stage, api] of Object.entries(manifest.apis || {})) {
    console.log(`    [${stage}] ${api.method} ${api.baseUrl}${api.path} score=${api.confidenceScore} label=${api.label || ""}`);
  }
}
const sessions = db.prepare("SELECT id, venue_name, status, created_at FROM venue_discovery_sessions ORDER BY created_at DESC LIMIT 3").all();
console.log("--- sessions:", JSON.stringify(sessions, null, 1));
