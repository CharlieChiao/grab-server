/**
 * 凭证管理: 读取 data/credentials.json
 * 结构: { "<venueId>": { ...球场自定义凭证 } }
 * 例: { "picklepop": { "PSPLVISITORID": "xxx" } }
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "..", "data", "credentials.json");

function ensure() {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "{}", "utf8");
}

export function getCredential(venueId) {
  ensure();
  try {
    const all = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return all[venueId] || null;
  } catch {
    return null;
  }
}

export function setCredential(venueId, cred) {
  ensure();
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {}
  all[venueId] = cred;
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2), "utf8");
  return all[venueId];
}

export function allCredentials() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}
