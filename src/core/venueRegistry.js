/**
 * 球场注册中心: 自动发现并加载 src/venues/ 下所有球场适配器。
 * 新增球场只需新建 venues/<id>/{index.js, venue.yml}, 无需改主程序。
 *
 * 适配器契约(模板, 参考 venues/picklepop):
 *  必须: meta{id,name} / ready(cred)→{ok,detail} 凭证有效性 / grab(target,cred) 下单
 *  可选: listSlots(query,cred)→[{uid,court,begin,canAppoint}] 场次查询(供释放轮询, slot 须归一化到该形状)
 *        classifyGrabResult(result) 风控分类 / preheat / buildGrabRequest+fireGrab 精度优化
 *        riskProfile{scopeKey,...} 限流配置
 *        payments{wechat,balance}   本场支付码语义声明(供 payCodes.paymentKind 解析, 支付生命周期/授权校验依赖)
 *  下单结果: success=true 时若需人工支付(如微信), 附 requiresManualPayment:true + orderId, 服务层自动进入待支付窗口
 */
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
      registry.set(adapter.meta.id, adapter);
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
