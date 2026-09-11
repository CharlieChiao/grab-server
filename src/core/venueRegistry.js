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
 *        courtUidsForType(type)→string[]|null 场地类型契约: 输入类型 key(tennis/pickle/..., 见 core/courtTypes.js)
 *        返回该类型场地的 uid 列表; 不支持该类型返回 null(前端变灰, 捡漏任务不可选该球场)。
 *        未显式实现的适配器由 registry 从 meta.courts[{type,uid}] 自动派生; courts 未声明则不支持任何类型。
 *        新增场地类型须先在 core/courtTypes.js 的注册表登记。
 *        listMyBookings(cred)→[{uid,amount,items[{court,begin,end,cost}],payments,...}] 已约场地列表(归一化)
 *        cancelBooking(cred,apptUid)→{ok,error?} 取消预约(整单取消全部场次)
 *        —— 预约管理契约: 供小程序查看/取消本人在场馆的订单; 不支持的球场 API 返回 501
 *  下单结果: success=true 时若需人工支付(如微信), 附 requiresManualPayment:true + orderId, 服务层自动进入待支付窗口
 */
const META_PUBLIC_FIELDS = ["logo", "desc", "advanceDays", "bookableDays", "release", "bookingHours", "courts"];

// meta.raw 公开字段自动展开到顶层(适配器显式声明优先), 新球场无需手工抄写 meta
// courts[].type 经注册表归一(中文/别名 → 标准 key), 保证跨场馆类型可比
function normalizeMeta(meta) {
  const raw = meta.raw || {};
  const merged = { ...meta };
  for (const field of META_PUBLIC_FIELDS) {
    if (merged[field] === undefined && raw[field] !== undefined) merged[field] = raw[field];
  }
  if (Array.isArray(merged.courts)) {
    merged.courts = merged.courts.map((c) => {
      const type = normalizeCourtType(c.type);
      if (type && !COURT_TYPES[type]) console.warn(`[venue] ${meta.id} 场地「${c.name}」类型「${type}」未在注册表登记, 作为独立类型处理`);
      return { ...c, type: type || undefined };
    });
  }
  return merged;
}
import { normalizeCourtType, COURT_TYPES } from "./courtTypes.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENUES_DIR = path.join(__dirname, "..", "venues");

const registry = new Map(); // id -> adapter

export async function loadVenues() {
  registry.clear();
  if (!fs.existsSync(VENUES_DIR)) return registry;
  const dirs = fs.readdirSync(VENUES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_")); // _ 前缀为共享适配器工厂目录
  for (const d of dirs) {
    const entry = path.join(VENUES_DIR, d.name, "index.js");
    if (!fs.existsSync(entry)) continue;
    try {
      // cache-busting query: ESM import 对同一 URL 有模块缓存, 不加时间戳则 venue-config 保存后的
      // 热重载会拿回启动时的旧模块(yml 配置是模块加载时读取的), 配置修改永远不生效。
      // 代价: 旧模块实例的 undici 连接池不会显式关闭, 但配置保存频率极低, 依靠 keepAliveTimeout 自然回收
      const mod = await import(pathToFileURL(entry).href + "?t=" + Date.now());
      const adapter = mod.default || mod;
      if (!adapter.meta || typeof adapter.grab !== "function" || typeof adapter.ready !== "function") {
        console.warn(`[venue] 跳过 ${d.name}: 未实现统一接口(meta/ready/grab)`);
        continue;
      }
      const registered = { ...adapter, meta: normalizeMeta(adapter.meta) };
      // 场地类型契约: courtUidsForType(type) → uid[]|null。未显式实现的适配器从 courts 派生;
      // courts 未声明任何场地 → 不支持任何类型(前端变灰, 无法创建/选中该球场的捡漏任务)
      if (typeof registered.courtUidsForType !== "function") {
        const byType = new Map();
        for (const c of registered.meta.courts || []) {
          if (!c.type || c.uid == null) continue;
          if (!byType.has(c.type)) byType.set(c.type, []);
          byType.get(c.type).push(String(c.uid));
        }
        registered.courtUidsForType = (type) => (type != null && byType.get(String(type))) || null;
      }
      registry.set(registered.meta.id, registered);
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
