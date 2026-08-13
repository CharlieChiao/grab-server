import crypto from "node:crypto";
import { db, nowIso } from "./database.js";

const SECRET = process.env.GRAB_API_AUTH_SECRET;
function b64(value) { return Buffer.from(value).toString("base64url"); }
function sign(input) { return crypto.createHmac("sha256", SECRET || "missing-secret").update(input).digest("base64url"); }

export function issueUserToken(openid, ttlSeconds = 86400) {
  const sub = crypto.createHash("sha256").update(String(openid)).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ sub, iat: now, exp: now + ttlSeconds }));
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

export function verifyUserToken(token) {
  if (!SECRET || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const expected = sign(`${parts[0]}.${parts[1]}`);
  if (parts[2].length !== expected.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return null; }
  if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) return null;
  const now = nowIso();
  db.prepare(`INSERT INTO users(id, openid_hash, created_at, last_seen_at) VALUES(?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(payload.sub, payload.sub, now, now);
  return { id: payload.sub };
}

export function requireUser(req, res, next) {
  const raw = req.get("authorization") || "";
  const user = verifyUserToken(raw.replace(/^Bearer\s+/i, ""));
  if (!user) return res.status(401).json({ error: "用户未认证或令牌已过期" });
  req.user = user;
  next();
}
