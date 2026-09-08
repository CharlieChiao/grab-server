import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/root/charliejiao/App/grab-server/data/grab.sqlite", { readOnly: true });
const jobs = db.prepare("SELECT id, status, group_uid, substr(created_at,1,16) created, target_json FROM jobs WHERE venue_id='funsport' ORDER BY created_at DESC LIMIT 6").all();
for (const j of jobs) {
  const t = JSON.parse(j.target_json);
  const alt = (t.alternates || []).map(a => `${a.court || (a.courts||[]).map(c=>c.court).join('+')} ${a.time}`).join('; ');
  console.log(`${j.created} [${j.status}] group=${(j.group_uid||'').slice(0,8)} ${t.court || (t.courts||[]).map(c=>c.court).join('+')} date=${t.date} ${t.time} alternates=[${alt}]`);
}
const groups = db.prepare("SELECT uid, name, status, iteration, repeat_weekly FROM task_groups ORDER BY created_at DESC LIMIT 4").all();
for (const g of groups) console.log(`group=${g.uid.slice(0,8)} "${g.name}" ${g.status} iter=${g.iteration} repeat=${g.repeat_weekly}`);
