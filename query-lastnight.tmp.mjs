import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/grab.sqlite");
// 昨晚(2026-09-06 12:00Z 之后)归档的任务
const jobs = db.prepare("SELECT id, venue_id, status, target_json, result_json, created_at, updated_at, archived_at FROM job_history WHERE archived_at >= '2026-09-06T12:00:00' ORDER BY archived_at").all();
console.log("=== archived jobs since last night:", jobs.length);
for (const job of jobs) {
  const target = JSON.parse(job.target_json || "{}");
  const result = JSON.parse(job.result_json || "{}");
  const courts = Array.isArray(target.courts) ? target.courts.map((c) => `${c.court || c.courtUid} ${c.time || target.time}`).join(" + ") : `${target.court || target.courtUid} ${target.time}`;
  console.log(`\n--- job=${job.id.slice(0, 8)} venue=${job.venue_id} ${courts} [${job.status}] archived=${job.archived_at}`);
  console.log(`    message: ${String(result.message || "").slice(0, 160)}`);
  console.log(`    paymentStatus=${result.paymentStatus || "-"} fallbackBy=${result.paymentFallbackBy || "-"} orderId=${result.orderId || "-"}`);
  const attempts = db.prepare("SELECT attempt, dispatched_at, drift_ms, classification, duration_ms, message FROM job_attempts WHERE job_id=? ORDER BY attempt").all(job.id);
  for (const a of attempts) console.log(`    attempt#${a.attempt} dispatch=${a.dispatched_at} class=${a.classification} dur=${a.duration_ms}ms msg=${String(a.message || "").slice(0, 60)}`);
}
// 关联任务组
const groups = db.prepare("SELECT uid, name, status FROM task_groups ORDER BY updated_at DESC LIMIT 3").all();
console.log("\n=== recent groups:", JSON.stringify(groups));
