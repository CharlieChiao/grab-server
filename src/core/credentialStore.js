import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, nowIso } from "./database.js";

const legacyFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "credentials.json");
function migrateLegacy() {
  if (db.prepare("SELECT COUNT(*) AS n FROM credentials").get().n || !fs.existsSync(legacyFile)) return;
  let all = {};
  try { all = JSON.parse(fs.readFileSync(legacyFile, "utf8")); } catch { return; }
  const userId = process.env.LEGACY_OWNER_USER_ID || "legacy-owner";
  const now = nowIso();
  db.prepare("INSERT OR IGNORE INTO users(id, created_at, last_seen_at) VALUES(?, ?, ?)").run(userId, now, now);
  const insert = db.prepare("INSERT OR REPLACE INTO credentials(user_id, venue_id, credential_json, updated_at, ready_ok) VALUES(?, ?, ?, ?, NULL)");
  for (const [venueId, cred] of Object.entries(all)) insert.run(userId, venueId, JSON.stringify(cred), now);
  console.log(`[db] migrated ${Object.keys(all).length} legacy credentials to ${userId}`);
}
migrateLegacy();

export function getCredential(venueId, userId = "legacy-owner") {
  const row = db.prepare("SELECT credential_json FROM credentials WHERE user_id=? AND venue_id=?").get(userId, venueId);
  if (!row) return null;
  try { return JSON.parse(row.credential_json); } catch { return null; }
}
export function setCredential(venueId, cred, userId = "legacy-owner") {
  const now = nowIso();
  db.prepare("INSERT OR IGNORE INTO users(id, created_at, last_seen_at) VALUES(?, ?, ?)").run(userId, now, now);
  db.prepare(`INSERT INTO credentials(user_id, venue_id, credential_json, updated_at, ready_ok) VALUES(?, ?, ?, ?, NULL)
    ON CONFLICT(user_id, venue_id) DO UPDATE SET credential_json=excluded.credential_json, updated_at=excluded.updated_at, ready_ok=NULL`).run(userId, venueId, JSON.stringify(cred), now);
  return cred;
}
export function credentialConfigured(venueId, userId = "legacy-owner") { return !!db.prepare("SELECT 1 FROM credentials WHERE user_id=? AND venue_id=?").get(userId, venueId); }

