/**
 * In Tennis 球场适配器 (CRMEB 场地预约系统)
 * 实现统一接口: meta / ready / grab / listSlots (+ classifyGrabResult / payments / riskProfile)
 *
 * CRMEB 下单链路(4 步, 每步失败即终止):
 *   cart/add → order/confirm(orderKey) → order/computed/<orderKey> → order/create/<orderKey>
 * 微信支付: create 返回 data.result.jsConfig(JSAPI 参数), 余额支付: payType=yue 直接扣款
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { Pool } from "undici";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = yaml.load(fs.readFileSync(path.join(__dirname, "venue.yml"), "utf8"));
const B = cfg.backend;

const pool = new Pool(B.base, {
  connections: 4,
  pipelining: 1,
  keepAliveTimeout: 60 * 1000,
  keepAliveMaxTimeout: 10 * 60 * 1000,
  connect: { timeout: 8000 },
});

function headers(cred) {
  return {
    "Authori-zation": cred["Authori-zation"],
    "store-id": String(B.storeId),
    "Form-type": "routine",
    "Content-Type": "application/json",
    Accept: "*/*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF",
  };
}

async function request(method, path_, cred, payload, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { statusCode, body } = await pool.request({
      method,
      path: path_,
      headers: headers(cred),
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await body.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: statusCode, json };
  } finally {
    clearTimeout(timer);
  }
}

const post = (path_, cred, payload, timeoutMs) => request("POST", path_, cred, payload, timeoutMs);
const get = (path_, cred, timeoutMs) => request("GET", path_, cred, undefined, timeoutMs);

const meta = { id: cfg.id, name: cfg.name, desc: cfg.desc, raw: cfg };
const riskProfile = {
  scopeKey: "in-tennis",
  booking: { minIntervalMs: 800, jitterMs: 200, notReleasedIntervalMs: 2000, transientIntervalMs: 3000, cooldownMs: 8000, maxRetry: 6 },
};

async function ready(cred) {
  const { status, json } = await get("/api/user", cred);
  if (status === 200 && json?.status === 200) return { ok: true, detail: "已登录" };
  return { ok: false, detail: (json && json.msg) || `HTTP ${status}` };
}

// CRMEB date_list: data.children[](时段 timeKey/time) × children[](场地 space_id/price/active)
// 归一化到统一 slot 形状 {uid, court, begin, canAppoint}, 额外保留 price/timeKey/time 供下单构造
async function listSlots(query, cred) {
  const { status, json } = await get(`/api/sports/space/date_list?date=${query.date}&store_id=${B.storeId}`, cred);
  if (status !== 200 || json?.status !== 200) throw new Error(json?.msg || `HTTP ${status}`);
  const slots = [];
  for (const hour of json.data?.children || []) {
    for (const space of hour.children || []) {
      slots.push({
        uid: String(space.space_id),
        court: space.name,
        begin: `${query.date} ${String(hour.timeKey).padStart(2, "0")}:00`,
        canAppoint: String(space.active) === "1" && Number(space.price) > 0,
        price: String(space.price),
        timeKey: Number(hour.timeKey),
        time: String(hour.time || ""),
      });
    }
  }
  return slots;
}

// 展开任务目标(单场/多场)为 CRMEB cart items, 实时校验可约性与价格
function buildItems(target, slots) {
  const slotMinutes = Math.max(30, Number(cfg.bookingHours?.slotMinutes) || 60);
  const wanted = Array.isArray(target.courts) && target.courts.length
    ? target.courts.map((court) => ({ uid: String(court.courtUid ?? ""), time: court.time || target.time }))
    : [{ uid: String(target.courtUid ?? ""), time: target.time }];
  return wanted.map((item) => {
    const startHour = Number(String(item.time || "").slice(0, 2));
    if (!Number.isFinite(startHour)) throw new Error(`时段无效: ${item.time}`);
    const slot = slots.find((entry) => entry.uid === item.uid && entry.timeKey === startHour);
    if (!slot) throw new Error(`未找到场次 ${item.uid} ${item.time}`);
    if (!slot.canAppoint) throw new Error(`场次不可预约(${slot.court} ${slot.time})`);
    const endHour = startHour + Math.round(slotMinutes / 60);
    const range = `${item.time}~${String(endHour % 24).padStart(2, "0")}:00`;
    return {
      space_id: Number(item.uid),
      price: slot.price,
      timeKey: startHour,
      specType: 1,
      time: range,
      full_time: range,
      name: slot.court,
      date: target.date,
      minidate: String(target.date).slice(5),
      id: `${startHour}_${item.uid}`,
      space_name: slot.court,
      spaceId: Number(item.uid),
    };
  });
}

async function grab(target, cred) {
  const payType = String(target.ext?.payMethod || B.payMethodWechat);
  const slots = await listSlots({ date: target.date }, cred);
  let items;
  try { items = buildItems(target, slots); }
  catch (error) { return { success: false, message: String(error.message || error) }; }
  const add = await post("/api/cart/add", cred, { cartNum: items.length, new: 1, store_id: B.storeId, order_type: B.orderType, items });
  if (add.json?.status !== 200) return { success: false, message: add.json?.msg || `加购失败(HTTP ${add.status})` };
  const cartId = (add.json.data?.cartId || [])[0];
  if (!cartId) return { success: false, message: "加购失败: 未返回 cartId" };
  const confirm = await post("/api/order/confirm", cred, { cartId, new: 1, addressId: 0, shipping_type: 1, store_id: B.storeId, couponId: 0, spaceCardId: 0, scene_type: 3, lighting_arr: [] });
  if (confirm.json?.status !== 200) return { success: false, message: confirm.json?.msg || "订单确认失败" };
  const orderKey = confirm.json.data?.orderKey;
  if (!orderKey) return { success: false, message: "订单确认失败: 未返回 orderKey" };
  const computed = await post(`/api/order/computed/${orderKey}`, cred, { addressId: 0, spaceCardId: 0, useIntegral: 0, useStorePoint: 0, couponId: 0, shipping_type: 1, payType, store_id: B.storeId, space_times: items.length });
  if (computed.json?.status !== 200) return { success: false, message: computed.json?.msg || "订单计价失败" };
  const created = await post(`/api/order/create/${orderKey}`, cred, { custom_form: [], real_name: "", phone: "", addressId: 0, formId: "", couponId: 0, payType, useIntegral: false, useStorePoint: false, bargainId: 0, combinationId: 0, discountId: 0, pinkId: 0, seckill_id: 0, spaceCardId: 0, mark: "", store_id: B.storeId, from: "routine", shipping_type: 1, new: 1, cartId, space_times: items.length, lighting_arr: [] });
  if (created.json?.status !== 200) return { success: false, message: created.json?.msg || "下单失败" };
  const result = created.json.data?.result || {};
  const orderId = result.orderId;
  if (!orderId) return { success: false, message: `下单失败: ${created.json.data?.status || "未返回订单号"}` };
  if (payType === B.payMethodWechat && result.jsConfig) {
    return { success: true, orderId, requiresManualPayment: true, message: "下单成功，等待微信支付", raw: created.json };
  }
  return { success: true, orderId, message: `下单成功(${created.json.data?.status || payType})`, raw: created.json };
}

export function classifyGrabResult(result) {
  if (result?.success) return "success";
  const text = String(result?.message || "");
  if (/频繁|稍后再试|too frequent/i.test(text)) return "rate-limited";
  if (/超时|timeout|网络/i.test(text)) return "transient";
  return "terminal";
}

export default { meta, riskProfile, ready, grab, listSlots, classifyGrabResult, payments: { wechat: B.payMethodWechat, balance: B.payMethodBalance } };
