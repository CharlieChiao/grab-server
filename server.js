/**
 * 球场抢订平台 - 主后端入口
 * 启动: node server.js  (端口默认 3000, 可用 PORT 环境变量)
 */
import express from "express";
import { loadVenues } from "./src/core/venueRegistry.js";
import { startScheduler } from "./src/core/scheduler.js";
import jobsApi from "./src/api/jobs.js";
import readyApi from "./src/api/ready.js";

const PORT = process.env.PORT || 3000;

async function main() {
  const app = express();
  app.use(express.json());

  // 加载所有球场适配器
  await loadVenues();

  // 路由
  app.use("/api/jobs", jobsApi);
  app.use("/api", readyApi);

  app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // 首页: 简单说明
  app.get("/", (req, res) => {
    res.json({
      name: "grab-court-server",
      endpoints: {
        "POST /api/jobs": "创建定时任务 {venueId,target:{court,date,time,cost,ext},fireAt}",
        "GET /api/jobs": "查询所有定时任务",
        "GET /api/jobs/:id": "查询单个任务",
        "DELETE /api/jobs/:id": "删除定时任务",
        "GET /api/venues": "列出所有球场",
        "GET /api/venues/:id": "球场配置",
        "GET /api/ready/:venueId": "实时ready检测(PSPLVISITORID有效性)",
        "GET /api/ready/:venueId/cache": "最近心跳检测结果",
        "PUT /api/credentials/:venueId": "更新球场凭证",
      },
    });
  });

  // 启动调度器(定时开抢 + 每小时心跳 + 开抢前每分钟检测)
  startScheduler();

  app.listen(PORT, () => {
    console.log(`[server] listening on :${PORT}`);
  });
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
