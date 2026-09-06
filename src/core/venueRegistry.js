/**
 * 球场注册中心: 自动发现并加载 src/venues/ 下所有球场适配器。
 * 新增球场只需新建 venues/<id>/{index.js, venue.yml}, 无需改主程序。
 *
 * 适配器契约(模板, 参考 venues/picklepop):
 *  必须: meta{id,name,raw=venue.yml解析结果} / ready(cred)→{ok,detail} 凭证有效性 / grab(target,cred) 下单
 *        meta.raw 中的公开字段(advanceDays/release/bookingHours/courts)注册时自动展开到 meta 顶层供前端消费,
 *        适配器无需逐字段手工抄写(backend/capture 等敏感段只保留在 raw)
 *  可选: listSlots(query,cred)→[{uid,court,begin,canAppoint,cost}] 场次查询
 *        slot 须归一化到该形状(cost=场次价格, 供参考价/释放轮询复用)
 *        classifyGrabResult(result) 风控分类 / preheat / buildGrabRequest+fireGrab 精度优化
 *        riskProfile{scopeKey,...} 限流配置
 *        payments{wechat,balance}   本场支付码语义声明(数字或字符串, 供 payCodes.paymentKind 解析)
 *  下单结果: success=true 时若需人工支付(如微信), 附 requiresManualPayment:true + orderId, 服务层自动进入待支付窗口
 */
const META_PUBLIC_FIELDS = ["advanceDays", "release", "bookingHours", "courts"];

// meta.raw 公开字段自动展开到顶层(适配器显式声明优先), 新球场无需手工抄写 meta
function normalizeMeta(meta) {
  const raw = meta.raw || {};
  const merged = { ...meta };
  for (const field of META_PUBLIC_FIELDS) {
    if (merged[field] === undefined && raw[field] !== undefined) merged[field] = raw[field];
  }
  return merged;
}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENUES_DIR = path.join(__dirname, "..", "venues");

const registry = new Map(); // id -> adapter

export async function loadVenues() {
  registry.clear();
  if (!fs.existsSync(VENUES_DIR)) return registry;
  const dirs = fs.readdirSync(VENUES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const entry = path.join(VENUES_DIR, d.name, "index.js");
    if (!fs.existsSync(entry)) continue;
    try {
      const mod = await import(pathToFileURL(entry).href);
      const adapter = mod.default || mod;
      if (!adapter.meta || typeof adapter.grab !== "function" || typeof adapter.ready !== "function") {
        console.warn(`[venue] 跳过 ${d.name}: 未实现统一接口(meta/ready/grab)`);
        continue;
      }
      registry.set(adapter.meta.id, { ...adapter, meta: normalizeMeta(adapter.meta) });
      console.log(`[venue] 已加载: ${adapter.meta.id} (${adapter.meta.name})`);
    } catch (e) {
      console.error(`[venue] 加载 ${d.name} 失败:`, e.message);
    }
  }
  return registry;
}

export function getVenue(id) {
  return registry.get(id);
}

export function listVenues() {
  return [...registry.values()].map((a) => a.meta);
}
