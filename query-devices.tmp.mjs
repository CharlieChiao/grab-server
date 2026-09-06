import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/grab.sqlite");
const rows = db.prepare("SELECT device_id, user_id, device_name, paired_at, revoked FROM devices ORDER BY paired_at DESC LIMIT 5").all();
console.log(JSON.stringify(rows, null, 1));
