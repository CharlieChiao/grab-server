/**
 * 球场注册中心: 自动发现并加载 src/venues/ 下所有球场适配器。
 * 新增球场只需新建 venues/<id>/{index.js, venue.yml}, 无需改主程序。
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
