import express from "express";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import YAML from "yaml";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../core/database.js";
import { listVenues, loadVenues } from "../core/venueRegistry.js";
import { prepareLogPayload } from "../core/serverLogs.js";
const router = express.Router();
const venuesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "venues");

// 表单模式的字段标题映射(按叶子 key 全局匹配, 新增字段未配置标题时前端回退显示字段名)
const FIELD_LABELS = {
  id: "ID", name: "名称", desc: "描述", logo: "Logo 地址", backend: "后端接口",
  base: "接口域名", storeId: "店铺 ID", projectUid: "项目 UID",
  payMethodBalance: "余额支付码", payMethodWechat: "微信支付码", orderType: "订单类型",
  advanceDays: "可浏览提前天数", pickle: "匹克球(天)", tennis: "网球(天)",
  release: "放场规则", timezone: "时区", rules: "规则明细",
  mode: "放场模式", calendarDaysBefore: "提前放场天数(日历日)", at: "放场时刻",
  bookingHours: "营业与时段", start: "开始时间", end: "结束时间",
  slotMinutes: "时段长度(分钟)", slotEndOffsetMinutes: "时段结束偏移(分钟)",
  releaseRetry: "放场重试", unavailableGraceMs: "不可约宽限(ms)", defaultMinIntervalMs: "默认最小间隔(ms)",
  jitterMs: "抖动(ms)", maxAttempts: "最大尝试次数",
  courts: "场地列表", uid: "唯一标识", type: "类型",
  credentialSchema: "凭证字段定义", capture: "抓包配置", enabled: "启用",
  hosts: "抓包域名", matchHeaders: "匹配请求头", paths: "抓包路径", headers: "抓包请求头",
  tasks: "采集任务", key: "字段 Key", label: "标签", required: "必填", maxAgeHours: "有效期(小时)",
  source: "数据来源", bookableDays: "可订范围(天)",
};
function requireDeveloper(req,res,next){ const row=db.prepare("SELECT developer FROM users WHERE id=?").get(req.user.id); if(!row?.developer)return res.status(403).json({error:"仅开发者可管理球场配置"}); next(); }
function configPath(id){ if(!/^[a-z0-9_-]+$/i.test(id))return null; const file=path.join(venuesDir,id,"venue.yml"); return file.startsWith(venuesDir+path.sep)?file:null; }
function validate(id,text){ if(Buffer.byteLength(text,"utf8")>262144)throw new Error("配置不能超过 256KB"); const value=yaml.load(text); if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("YAML 根节点必须是对象"); if(value.id&&String(value.id)!==id)throw new Error("配置 id 与球场 id 不一致"); if(!value.name)throw new Error("缺少 name"); if(!value.bookingHours?.start||!value.bookingHours?.end)throw new Error("缺少 bookingHours.start/end"); return value; }
const execFileAsync = promisify(execFile);
router.get("/developer/logs", requireDeveloper, async (req,res) => {
  const lines=Math.max(20,Math.min(1000,Number(req.query.lines)||300));
  const scope=req.query.scope==="business"?"business":"all";
  const hours=Math.max(1,Math.min(168,Number(req.query.hours)||24));
  const args=scope==="business"
    ? ["-u","grab-server","--since",`${hours} hours ago`,"-n","5000","--no-pager","-o","short-iso"]
    : ["-u","grab-server","-n",String(lines),"--no-pager","-o","short-iso"];
  try { const {stdout}=await execFileAsync("journalctl",args,{timeout:5000,maxBuffer:4*1024*1024}); const payload=prepareLogPayload(stdout,{business:scope==="business",lines}); res.set("Cache-Control","no-store").json({ok:true,...payload,scope,hours:scope==="business"?hours:null}); }
  catch(error) { res.status(502).json({error:"读取服务器日志失败",detail:String(error.message||error)}); }
});
let restartQueued = false;
router.post("/developer/restart", requireDeveloper, async (req,res) => {
  if (restartQueued) return res.status(409).json({error:"服务重启已在处理中"});
  restartQueued = true;
  const unit = `grab-server-restart-${Date.now()}`;
  try {
    await execFileAsync("/usr/bin/systemd-run", ["--unit",unit,"--on-active=2s","--collect","/usr/bin/systemctl","restart","grab-server"], {timeout:5000});
    console.warn(`[server-restart] requested by user=${req.user.id} unit=${unit}`);
    res.status(202).json({ok:true,message:"重启指令已发送，服务将在几秒内恢复"});
  } catch (error) {
    restartQueued=false;
    console.error("[server-restart]", String(error.message||error));
    res.status(500).json({error:"无法安排服务重启"});
  }
});
router.use("/developer/venue-configs",requireDeveloper);
router.get("/developer/venue-configs",(req,res)=>res.json({ok:true,venues:listVenues()}));
router.get("/developer/venue-configs/:id",(req,res)=>{ const file=configPath(req.params.id); if(!file||!fs.existsSync(file))return res.status(404).json({error:"球场配置不存在"}); res.json({ok:true,id:req.params.id,yaml:fs.readFileSync(file,"utf8")}); });
router.put("/developer/venue-configs/:id",async(req,res)=>{ const file=configPath(req.params.id),text=String(req.body?.yaml||""); if(!file||!fs.existsSync(file))return res.status(404).json({error:"球场配置不存在"}); try{ validate(req.params.id,text); const backup=file+".bak"; fs.copyFileSync(file,backup); fs.writeFileSync(file,text,"utf8"); await loadVenues(); if(!listVenues().some(v=>v.id===req.params.id)){fs.copyFileSync(backup,file);await loadVenues();throw new Error("配置加载失败，已恢复原配置");} res.json({ok:true,message:"配置已保存并重新加载"}); }catch(error){res.status(400).json({error:String(error.message||error)});} });

// 结构化表单模式: 返回 yml 的 JSON 形态 + 字段标题映射(前端按类型推断渲染控件)
router.get("/developer/venue-configs/:id/structured",(req,res)=>{
  const file=configPath(req.params.id);
  if(!file||!fs.existsSync(file))return res.status(404).json({error:"球场配置不存在"});
  try { res.json({ ok:true, id:req.params.id, data:yaml.load(fs.readFileSync(file,"utf8"))||{}, labels:FIELD_LABELS }); }
  catch(error){ res.status(400).json({error:"YAML 解析失败: "+String(error.message||error)}); }
});

// 结构化保存: 按 path 应用增量 patch, 基于 eemeli/yaml 的文档模型编辑, 保留原有注释
router.put("/developer/venue-configs/:id/structured",async(req,res)=>{
  const file=configPath(req.params.id);
  const patches=Array.isArray(req.body?.patches)?req.body.patches:null;
  if(!file||!fs.existsSync(file))return res.status(404).json({error:"球场配置不存在"});
  if(!patches||!patches.every((p)=>Array.isArray(p?.path)&&p.path.every((k)=>["string","number"].includes(typeof k))))return res.status(400).json({error:"patches 格式无效"});
  try {
    const doc=YAML.parseDocument(fs.readFileSync(file,"utf8"));
    for(const p of patches){
      if(p.op==="delete") doc.deleteIn(p.path);
      else doc.setIn(p.path,p.value===undefined?null:p.value);
    }
    const next=doc.toString();
    validate(req.params.id,next);
    const backup=file+".bak";
    fs.copyFileSync(file,backup);
    fs.writeFileSync(file,next,"utf8");
    await loadVenues();
    if(!listVenues().some(v=>v.id===req.params.id)){fs.copyFileSync(backup,file);await loadVenues();throw new Error("配置加载失败，已恢复原配置");}
    res.json({ok:true,message:"配置已保存并重新加载(注释保留)",applied:patches.length});
  }catch(error){res.status(400).json({error:String(error.message||error)});}
});
export default router;
