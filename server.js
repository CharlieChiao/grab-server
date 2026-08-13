/**
 * 鐞冨満鎶㈣骞冲彴 - 涓诲悗绔叆鍙?
 * 鍚姩: node server.js  (绔彛榛樿 3000, 鍙敤 PORT 鐜鍙橀噺)
 */
import express from "express";
import { loadVenues } from "./src/core/venueRegistry.js";
import { startScheduler } from "./src/core/scheduler.js";
import jobsApi from "./src/api/jobs.js";
import readyApi from "./src/api/ready.js";
import { requireUser } from "./src/core/auth.js";
import authApi from "./src/api/auth.js";

const PORT = process.env.PORT || 3000;

async function main() {
  const app = express();
  app.use(express.json());

  // 鍔犺浇鎵€鏈夌悆鍦洪€傞厤鍣?
  await loadVenues();

  // 璺敱
  app.use("/api/auth", authApi);
  app.use("/api", (req, res, next) => {
    if (req.path === "/venues" || req.path.startsWith("/venues/")) return next();
    return requireUser(req, res, next);
  });
  app.use("/api/jobs", jobsApi);
  app.use("/api", readyApi);

  app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // 棣栭〉: 绠€鍗曡鏄?
  app.get("/", (req, res) => {
    res.json({
      name: "grab-court-server",
      endpoints: {
        "POST /api/jobs": "鍒涘缓瀹氭椂浠诲姟 {venueId,target:{court,date,time,cost,ext},fireAt}",
        "GET /api/jobs": "list jobs",
        "GET /api/jobs/:id": "鏌ヨ鍗曚釜浠诲姟",
        "DELETE /api/jobs/:id": "鍒犻櫎瀹氭椂浠诲姟",
        "GET /api/venues": "list venues",
        "GET /api/venues/:id": "鐞冨満閰嶇疆",
        "GET /api/ready/:venueId": "瀹炴椂ready妫€娴?PSPLVISITORID鏈夋晥鎬?",
        "GET /api/ready/:venueId/cache": "cached ready result",
        "PUT /api/credentials/:venueId": "鏇存柊鐞冨満鍑瘉",
        "POST /api/credentials/:venueId/ingest": "鎺ユ敹抓包文本并验证 PSPLVISITORID",
      },
    });
  });

  // 鍚姩璋冨害鍣?瀹氭椂寮€鎶?+ 姣忓皬鏃跺績璺?+ 寮€鎶㈠墠姣忓垎閽熸娴?
  startScheduler();

  app.listen(PORT, () => {
    console.log(`[server] listening on :${PORT}`);
  });
}

main().catch((e) => {
  console.error("鍚姩澶辫触:", e);
  process.exit(1);
});



