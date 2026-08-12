/**
 * 定时任务持久化 (JSON 文件)。
 * 任务结构:
 * {
 *   id, venueId, target:{court,date,time,cost,ext},
 *   fireAt: ISO时间(开抢时刻),
 *   status: 'pending'|'running'|'done'|'failed'|'canceled',
 *   result, createdAt, updatedAt
 * }
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "..", "config", "jobs.json");

function ensure() {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "[]", "utf8");
}

function readAll() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeAll(list) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), "utf8");
}

export function listJobs() {
  return readAll();
}

export function getJob(id) {
  return readAll().find((j) => j.id === id);
}

export function createJob({ venueId, target, fireAt }) {
  const list = readAll();
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    venueId,
    target,
    fireAt: fireAt || null, // null = 立即执行
    status: "pending",
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  list.push(job);
  writeAll(list);
  return job;
}

export function updateJob(id, patch) {
  const list = readAll();
  const idx = list.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch, updatedAt: new Date().toISOString() };
  writeAll(list);
  return list[idx];
}

export function deleteJob(id) {
  const list = readAll();
  const next = list.filter((j) => j.id !== id);
  writeAll(next);
  return next.length !== list.length;
}
