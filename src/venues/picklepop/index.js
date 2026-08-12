/**
 * PICKLE POP 球场适配器 (银豹 Pospal 后端)
 * 实现统一接口: meta / ready / grab / listSlots (+ 可选 preheat / buildGrabRequest)
 *
 * 高精度抢购设计:
 *  - 使用 undici 的 keep-alive Pool 复用 TCP/TLS 连接 (避免首发时的握手开销)
 *  - preheat(): 抢购前主动建连 + 一次轻量请求预热
 *  - buildGrabRequest(): 预构建请求 URL / headers / body, 到点立刻 dispatch
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { Pool, request as undiciRequest } from "undici";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取声明式配置
const cfg = yaml.load(fs.readFileSync(path.join(__dirname, "venue.yml"), "utf8"));
const B = cfg.backend;

/**
 * 长连接池 (针对银豹域名), 复用 TCP/TLS, 抢购首发不再付握手成本。
 * connections: 允许多路并发, keepAliveTimeout: 长一点避免闲置断开。
 */
const pool = new Pool(B.base, {
  connections: 8,
  pipelining: 1,
  keepAliveTimeout: 60 * 1000,
  keepAliveMaxTimeout: 10 * 60 * 1000,
  connect: { timeout: 8000 },
});

/** 构造银豹请求头 */
function headers(cred) {
  return {
    PSPLVISITORAUTO: "API",
    VERSIONINFO: "NC|2026.04.16",
    STOREID: String(B.storeId),
    xweb_xhr: "1",
    APPTYPE: "3",
    POSPALSTOREMODE: "RegularOrder|takeout",
    PSPLVISITORID: cred.PSPLVISITORID,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541c1a) XWEB/25297",
    "Content-Type": "application/json",
    Accept: "*/*",
    Referer: "https://servicewechat.com/wx080059a4923a736f/2/page-frame.html",
  };
}

/**
 * 统一 POST (走 pool, 复用连接)
 */
async function post(path_, cred, payload, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { statusCode, body } = await pool.request({
      method: "POST",
      path: path_,
      headers: headers(cred),
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await body.text();
    try {
      return { status: statusCode, json: JSON.parse(text) };
    } catch {
      return { status: statusCode, json: null, text };
    }
  } finally {
    clearTimeout(t);
  }
}

const uidByName = Object.fromEntries(cfg.courts.map((c) => [c.name, c.uid]));

/** meta: 供前端展示 */
export const meta = {
  id: cfg.id,
  name: cfg.name,
  logo: cfg.logo,
  desc: cfg.desc,
  advanceDays: cfg.advanceDays,
  courts: cfg.courts,
  raw: cfg,
};

/**
 * ready 检测 = PSPLVISITORID 有效性 (含抖动重试)
 */
export async function ready(cred) {
  if (!cred || !cred.PSPLVISITORID) {
    return { ok: false, detail: "缺少 PSPLVISITORID" };
  }
  let last = null;
  for (let i = 0; i < 3; i++) {
    try {
      const { json } = await post("/wxapi/customeraccount/FindLoginInfo", cred, {
        storeId: B.storeId,
        isRefresh: true,
      });
      last = json;
      if (json && json.isLogin) {
        return {
          ok: true,
          detail: `已登录: ${json.name || ""} ${json.phone || ""}`,
          extra: { balance: json.balance, uid: json.uid },
        };
      }
    } catch (e) {
      last = { error: String(e) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, detail: "登录态无效(可能PSPLVISITORID已过期,需重新抓包)", extra: last || {} };
}

/**
 * 预热: 建立/保持长连接, 让抢购首发无握手成本。
 * 通过发一个轻量的登录态查询请求把连接池热起来。
 */
export async function preheat(cred) {
  if (!cred || !cred.PSPLVISITORID) return { ok: false, detail: "缺少 PSPLVISITORID" };
  try {
    const t0 = Date.now();
    await post("/wxapi/customeraccount/FindLoginInfo", cred, {
      storeId: B.storeId,
      isRefresh: false,
    }, 5000);
    return { ok: true, detail: `预热完成, 耗时 ${Date.now() - t0}ms` };
  } catch (e) {
    return { ok: false, detail: "预热失败: " + String(e) };
  }
}

/**
 * 预构建抢购请求 (URL/headers/body 提前拼好, 到点直接 dispatch)
 *
 * target 支持两种形态:
 *   1) 单场地(旧): { court, date, time, cost, ext? }
 *   2) 多场地/多时段(新): { date, courts: [{court, time, cost}, ...], ext? }
 *      - 同一订单一次性下多个 classroomItems, 成功则全部抢到, 失败全部失败(银豹原生行为)
 *      - 也支持 { courts:[...], time, cost } 顶层公共字段 (同一时段多场地)
 *
 * @returns {{ path:string, headers:object, body:string }}
 */
export function buildGrabRequest(target, cred) {
  const items = normalizeItems(target);
  const totalCost = items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
  const payMethod = (target.ext && target.ext.payMethod) || B.payMethodBalance;
  const payload = {
    userId: B.storeId,
    projectType: (target.ext && target.ext.projectType) || 0,
    classroomItems: items.map((it) => ({
      classroomUid: it.uid,
      beginDatetime: it.begin,
      endDatetime: it.end,
      peopleNum: 1,
    })),
    remark: "",
    combinationPayments: [{ paymentMethod: payMethod, cost: totalCost }],
  };
  return {
    path: "/wxapi/AppointmentVenue/SaveVenueAppointmentV2",
    headers: headers(cred),
    body: JSON.stringify(payload),
  };
}

/**
 * 把 target 统一归一化为 items: [{uid, begin, end, cost}]
 * 兼容:
 *   { court, date, time, cost }                                 -> 1 项
 *   { date, courts:["A","B"], time, cost }                      -> N 项(同时段)
 *   { date, courts:[{court,time,cost}, ...] }                   -> N 项(可各时段)
 *   { date, courts:[{court}], time, cost }                      -> 混合
 */
function normalizeItems(target) {
  const date = target.date;
  if (!date) throw new Error("target.date 必填");

  const toItem = (courtName, time, cost) => {
    if (!courtName) throw new Error("courts[].court 必填");
    if (!time) throw new Error("time 必填(顶层或每项)");
    const uid = uidByName[courtName] || courtName;
    const [h] = String(time).split(":");
    return {
      uid,
      begin: `${date} ${time}:00`,
      end: `${date} ${h}:59:00`,
      cost: cost != null ? cost : 0,
    };
  };

  // 多场地形态
  if (Array.isArray(target.courts) && target.courts.length > 0) {
    return target.courts.map((c) => {
      if (typeof c === "string") {
        return toItem(c, target.time, target.cost);
      }
      return toItem(c.court, c.time || target.time, c.cost != null ? c.cost : target.cost);
    });
  }

  // 单场地形态(向后兼容)
  return [toItem(target.court, target.time, target.cost)];
}

/**
 * 单次抢票请求 (走预构建, 极简路径, 用于高精度首发或重试)
 */
async function fireOnce(prebuilt, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { statusCode, body } = await pool.request({
      method: "POST",
      path: prebuilt.path,
      headers: prebuilt.headers,
      body: prebuilt.body,
      signal: ctrl.signal,
    });
    const text = await body.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: statusCode, json, text };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 抢票入口 (兼容原签名: 允许直接调用, 内部走 buildGrabRequest + fireOnce)
 * scheduler 高精度模式会直接用 buildGrabRequest + fireOnce, 不走这里。
 */
export async function grab(target, cred) {
  const prebuilt = buildGrabRequest(target, cred);
  const { json } = await fireOnce(prebuilt);
  return interpretGrabResponse(json);
}

/** 解释银豹返回 */
export function interpretGrabResponse(json) {
  if (json && json.successed) {
    const res = json.result || {};
    if (res.script) {
      return {
        success: true,
        orderId: res.apptUid,
        message: "下单成功但返回微信支付参数(余额可能不足), 需手动支付",
        raw: json,
      };
    }
    return { success: true, orderId: res.apptUid, message: "抢到并已余额支付", raw: json };
  }
  return {
    success: false,
    message: (json && (json.message || JSON.stringify(json.messages) || `errorCode=${json.errorCode}`)) || "下单失败",
    raw: json,
  };
}

/** 高精度首发: 由 scheduler 调用. 单次极简发射(不含重试, 重试由 scheduler 控) */
export async function fireGrab(prebuilt) {
  const { json } = await fireOnce(prebuilt);
  return interpretGrabResponse(json);
}

/** (可选) 查询某天可约时段 */
export async function listSlots(query, cred) {
  const { json } = await post("/wxapi/AppointmentVenue/LoadValidClassRoomApptSettingV2", cred, {
    dateTime: query.date,
    userId: B.storeId,
    projectUid: B.projectUid,
  });
  const slots = (json && json.result && json.result.slots) || [];
  return slots.map((s) => ({
    court: s.classRoomName,
    uid: s.txtClassroomUid || String(s.classroomUid),
    begin: s.beginDatetime,
    end: s.endDatetime,
    cost: s.cost,
    canAppoint: s.apptInfo && s.apptInfo.canApptOrNot,
    message: s.apptInfo && s.apptInfo.errorMessage,
  }));
}

export default { meta, ready, grab, preheat, buildGrabRequest, fireGrab, listSlots, interpretGrabResponse };
