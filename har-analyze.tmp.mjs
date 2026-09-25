// 逐请求对比 har 中的 Authorization 身份(用户可能有两个账号)
import fs from "node:fs";

for (const file of ["d:/Project/CourtCapture/hars/chai_weilaihui_lsitorder.har", "d:/Project/CourtCapture/hars/chai_weilaihui_lsitorder_1.har"]) {
  console.log("\n##### " + file.split("/").pop());
  const har = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const e of har.log.entries || []) {
    const req = e.request || {};
    const url = new URL(req.url);
    if (!/\.crland\.com\.cn/.test(url.hostname)) continue;
    const auth = (req.headers || []).find((h) => h.name.toLowerCase() === "authorization");
    if (!auth) continue;
    let identity = "?";
    try {
      const p = JSON.parse(Buffer.from(String(auth.value).replace(/^Wechat\s+/i, "").split(".")[1], "base64").toString("utf8"));
      identity = p.memberMobile || p.openid;
    } catch {}
    let summary = "";
    try {
      const resp = JSON.parse((e.response && e.response.content && e.response.content.text) || "{}");
      if (resp.result && typeof resp.result === "object") {
        if (resp.result.count != null) summary = `count=${resp.result.count}`;
        else if (resp.result.orderStatus) summary = `orderStatus=${resp.result.orderStatus}`;
      }
    } catch {}
    console.log(`${String(e.startedDateTime || "").slice(11, 19)} ${url.pathname.slice(0, 45)} [${identity}] ${summary}`);
  }
}
