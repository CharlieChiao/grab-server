import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/grab.sqlite");
const jobs = db.prepare("SELECT id, user_id, created_by_user_id, target_json FROM job_history WHERE archived_at >= '2026-09-06T15:00:00' AND venue_id='picklepop' ORDER BY archived_at").all();
for (const job of jobs) {
  const target = JSON.parse(job.target_json || "{}");
  const courts = Array.isArray(target.courts) ? target.courts.map((c) => c.court).join("+") : target.court;
  console.log(`job=${job.id.slice(0, 8)} court=${courts} owner=${job.user_id.slice(0, 10)} createdBy=${job.created_by_user_id.slice(0, 10)} ${job.user_id === job.created_by_user_id ? "(自建)" : "(代理)"}`);
}
const users = db.prepare("SELECT id, nickname FROM users").all();
console.log("\nusers:", users.map(u => `${u.id.slice(0, 10)}=${u.nickname}`).join("  "));
