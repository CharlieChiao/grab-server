import express from "express";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import { db } from "../core/database.js";
import { listVenues, loadVenues } from "../core/venueRegistry.js";
const router = express.Router();
const venuesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "venues");
function requireDeveloper(req,res,next){ const row=db.prepare("SELECT developer FROM users WHERE id=?").get(req.user.id); if(!row?.developer)return res.status(403).json({error:"仅开发者可管理球场配置"}); next(); }
function configPath(id){ if(!/^[a-z0-9_-]+$/i.test(id))return null; const file=path.join(venuesDir,id,"venue.yml"); return file.startsWith(venuesDir+path.sep)?file:null; }
function validate(id,text){ if(Buffer.byteLength(text,"utf8")>262144)throw new Error("配置不能超过 256KB"); const value=yaml.load(text); if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("YAML 根节点必须是对象"); if(value.id&&String(value.id)!==id)throw new Error("配置 id 与球场 id 不一致"); if(!value.name)throw new Error("缺少 name"); if(!value.bookingHours?.start||!value.bookingHours?.end)throw new Error("缺少 bookingHours.start/end"); return value; }
router.use("/developer/venue-configs",requireDeveloper);
router.get("/developer/venue-configs",(req,res)=>res.json({ok:true,venues:listVenues()}));
router.get("/developer/venue-configs/:id",(req,res)=>{ const file=configPath(req.params.id); if(!file||!fs.existsSync(file))return res.status(404).json({error:"球场配置不存在"}); res.json({ok:true,id:req.params.id,yaml:fs.readFileSync(file,"utf8")}); });
router.put("/developer/venue-configs/:id",async(req,res)=>{ const file=configPath(req.params.id),text=String(req.body?.yaml||""); if(!file||!fs.existsSync(file))return res.status(404).json({error:"球场配置不存在"}); try{ validate(req.params.id,text); const backup=file+".bak"; fs.copyFileSync(file,backup); fs.writeFileSync(file,text,"utf8"); await loadVenues(); if(!listVenues().some(v=>v.id===req.params.id)){fs.copyFileSync(backup,file);await loadVenues();throw new Error("配置加载失败，已恢复原配置");} res.json({ok:true,message:"配置已保存并重新加载"}); }catch(error){res.status(400).json({error:String(error.message||error)});} });
export default router;