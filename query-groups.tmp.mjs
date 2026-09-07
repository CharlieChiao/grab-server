import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/root/charliejiao/App/grab-server/data/grab.db");
const hist = db.prepare("SELECT group_uid, COUNT(*) n FROM job_history WHERE group_uid IS NOT NULL GROUP BY group_uid").all();
console.log("history groups:", JSON.stringify(hist));
const groups = db.prepare("SELECT uid, name, status, created_at FROM task_groups ORDER BY created_at DESC LIMIT 8").all();
console.log("task_groups:", JSON.stringify(groups, null, 1));
const sample = db.prepare("SELECT id, group_uid, status, substr(created_at,1,19) created, substr(archived_at,1,19) archived FROM job_history ORDER BY archived_at DESC LIMIT 8").all();
console.log("recent history:", JSON.stringify(sample, null, 1));
