// 查 10-11 周日场次现状(判断失败任务是否值得重建)
import { DatabaseSync } from "node:sqlite";
import { constants } from "node:crypto";
import https from "node:https";

const db = new DatabaseSync("/root/charliejiao/App/grab-server/data/grab.sqlite", { readOnly: true });
const row = db.prepare("SELECT credential_json FROM credentials WHERE venue_id='wlh-dwq' AND user_id=(SELECT user_id FROM job_history WHERE venue_id='wlh-dwq' ORDER BY updated_at DESC LIMIT 1)").get();
const cred = JSON.parse(row.credential_json);
const token = String(cred.Authorization || "").startsWith("Wechat ") ? cred.Authorization : `Wechat ${cred.Authorization}`;
const agent = new https.Agent({ rejectUnauthorized: false, secureOptions: constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION });
const AREA = "cec42d973dee11f1b51c2273436a3e4e";

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host: "wlhmobile.crland.com.cn", path, method: "POST", agent,
      headers: { Authorization: token, "Content-Type": "application/json", Accept: "*/*", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(out.slice(0, 200))); } });
    });
    req.on("error", reject);
    req.end(data);
  });
}

const matrix = await post("/business/client/field/area/matrix", { fieldAreaUuid: AREA, reserveDate: "2026-10-11", enterpriseUuid: "", discountSpecUuid: "", projectUuid: "0ddda9c33d4e11f1b51c2273436a3e4e" });
if (matrix.code !== 200) { console.log("ERROR:", matrix.text); process.exit(0); }
const r = matrix.result || {};
const nameByUuid = Object.fromEntries((r.fieldList || []).map((f) => [f.fieldUuid, f.fieldName]));
for (const rowM of r.matrix || []) {
  for (const cell of rowM.matrix || []) {
    const court = nameByUuid[cell.fieldUuid] || "?";
    if (/2号|3号/.test(court) && ["14:00", "15:00", "16:00"].includes(String(cell.startTime || "").slice(11, 16))) {
      console.log(court, String(cell.startTime || "").slice(11, 16), cell.isAbleReserve ? "✓可约 ¥" + cell.price : "✗已占");
    }
  }
}
