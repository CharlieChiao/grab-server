import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/root/charliejiao/App/grab-server/data/grab.sqlite", { readOnly: true });
const jobs = db.prepare("SELECT id, user_id, created_by_user_id, fire_at, target_json FROM jobs WHERE fire_at LIKE '2026-09-08T16%' ORDER BY created_at").all();
for (const j of jobs) {
  const t = JSON.parse(j.target_json);
  console.log(`fire=${j.fire_at} user=${j.user_id.slice(0, 8)} createdBy=${j.created_by_user_id.slice(0, 8)} ${t.court || (t.courts || []).map(c => c.court).join('+')} ${t.date} ${t.time} alternates=${(t.alternates || []).length}`);
}
