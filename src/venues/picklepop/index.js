/**
 * PICKLE POP 鐞冨満閫傞厤鍣?(閾惰惫 Pospal 鍚庣)
 * 瀹炵幇缁熶竴鎺ュ彛: meta / ready / grab / listSlots (+ 鍙€?preheat / buildGrabRequest)
 *
 * 楂樼簿搴︽姠璐璁?
 *  - 浣跨敤 undici 鐨?keep-alive Pool 澶嶇敤 TCP/TLS 杩炴帴 (閬垮厤棣栧彂鏃剁殑鎻℃墜寮€閿€)
 *  - preheat(): 鎶㈣喘鍓嶄富鍔ㄥ缓杩?+ 涓€娆¤交閲忚姹傞鐑?
 *  - buildGrabRequest(): 棰勬瀯寤鸿姹?URL / headers / body, 鍒扮偣绔嬪埢 dispatch
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { Pool, request as undiciRequest } from "undici";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 璇诲彇澹版槑寮忛厤缃?
const cfg = yaml.load(fs.readFileSync(path.join(__dirname, "venue.yml"), "utf8"));
const B = cfg.backend;

/**
 * 闀胯繛鎺ユ睜 (閽堝閾惰惫鍩熷悕), 澶嶇敤 TCP/TLS, 鎶㈣喘棣栧彂涓嶅啀浠樻彙鎵嬫垚鏈€?
 * connections: 鍏佽澶氳矾骞跺彂, keepAliveTimeout: 闀夸竴鐐归伩鍏嶉棽缃柇寮€銆?
 */
const pool = new Pool(B.base, {
  connections: 8,
  pipelining: 1,
  keepAliveTimeout: 60 * 1000,
  keepAliveMaxTimeout: 10 * 60 * 1000,
  connect: { timeout: 8000 },
});

/** 鏋勯€犻摱璞硅姹傚ご */
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
 * 缁熶竴 POST (璧?pool, 澶嶇敤杩炴帴)
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
const slotMinutes = Math.max(1, Number((cfg.bookingHours || {}).slotMinutes) || 60);

function addMinutes(date, time, minutes) {
  const [year, month, day] = String(date).split("-").map(Number);
  const [hour, minute] = String(time).split(":").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day, hour, minute) + minutes * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${result.getUTCFullYear()}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())} ${pad(result.getUTCHours())}:${pad(result.getUTCMinutes())}:00`;
}

/** meta: 渚涘墠绔睍绀?*/
export const meta = {
  id: cfg.id,
  name: cfg.name,
  logo: cfg.logo,
  desc: cfg.desc,
  advanceDays: cfg.advanceDays,
  release: cfg.release,
  bookingHours: cfg.bookingHours,
  courts: cfg.courts,
  raw: cfg,
};

export const riskProfile = {
  scopeKey: "pospal:store:5972810",
  mode: "serial-linear-backoff",
  calibration: { samples: 6, decreaseStepMs: 250, minIntervalMs: 1000, blackoutMinutes: 30 },
  booking: {
    minIntervalMs: 3000,
    jitterMs: 800,
    cooldownMs: 10000,
    maxRetry: 40,
    notReleasedIntervalMs: 3000,
    transientIntervalMs: 3000,
    increaseStepMs: 500,
    cooldownStepMs: 5000,

  },
};

/**
 * ready 妫€娴?= PSPLVISITORID 鏈夋晥鎬?(鍚姈鍔ㄩ噸璇?
 */
export async function ready(cred) {
  if (!cred || !cred.PSPLVISITORID) {
    return { ok: false, detail: "缂哄皯 PSPLVISITORID" };
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
          detail: `宸茬櫥褰? ${json.name || ""} ${json.phone || ""}`,
          extra: { balance: json.balance, uid: json.uid },
        };
      }
    } catch (e) {
      last = { error: String(e) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, detail: "鐧诲綍鎬佹棤鏁?鍙兘PSPLVISITORID宸茶繃鏈?闇€閲嶆柊鎶撳寘)", extra: last || {} };
}

/**
 * 棰勭儹: 寤虹珛/淇濇寔闀胯繛鎺? 璁╂姠璐鍙戞棤鎻℃墜鎴愭湰銆?
 * 閫氳繃鍙戜竴涓交閲忕殑鐧诲綍鎬佹煡璇㈣姹傛妸杩炴帴姹犵儹璧锋潵銆?
 */
export async function preheat(cred) {
  if (!cred || !cred.PSPLVISITORID) return { ok: false, detail: "缂哄皯 PSPLVISITORID" };
  try {
    const t0 = Date.now();
    await post("/wxapi/customeraccount/FindLoginInfo", cred, {
      storeId: B.storeId,
      isRefresh: false,
    }, 5000);
    return { ok: true, detail: `棰勭儹瀹屾垚, 鑰楁椂 ${Date.now() - t0}ms` };
  } catch (e) {
    return { ok: false, detail: "棰勭儹澶辫触: " + String(e) };
  }
}

/**
 * 棰勬瀯寤烘姠璐姹?(URL/headers/body 鎻愬墠鎷煎ソ, 鍒扮偣鐩存帴 dispatch)
 *
 * target 鏀寔涓ょ褰㈡€?
 *   1) 鍗曞満鍦?鏃?: { court, date, time, cost, ext? }
 *   2) 澶氬満鍦?澶氭椂娈?鏂?: { date, courts: [{court, time, cost}, ...], ext? }
 *      - 鍚屼竴璁㈠崟涓€娆℃€т笅澶氫釜 classroomItems, 鎴愬姛鍒欏叏閮ㄦ姠鍒? 澶辫触鍏ㄩ儴澶辫触(閾惰惫鍘熺敓琛屼负)
 *      - 涔熸敮鎸?{ courts:[...], time, cost } 椤跺眰鍏叡瀛楁 (鍚屼竴鏃舵澶氬満鍦?
 *
 * @returns {{ path:string, headers:object, body:string }}
 */
export function buildGrabRequest(target, cred) {
  const items = normalizeItems(target);
  const explicitTotal = Number(target.ext && target.ext.totalCost);
  const totalCost = Number.isFinite(explicitTotal) && explicitTotal > 0
    ? explicitTotal
    : items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
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
 * 鎶?target 缁熶竴褰掍竴鍖栦负 items: [{uid, begin, end, cost}]
 * 鍏煎:
 *   { court, date, time, cost }                                 -> 1 椤?
 *   { date, courts:["A","B"], time, cost }                      -> N 椤?鍚屾椂娈?
 *   { date, courts:[{court,time,cost}, ...] }                   -> N 椤?鍙悇鏃舵)
 *   { date, courts:[{court}], time, cost }                      -> 娣峰悎
 */
function normalizeItems(target) {
  const date = target.date;
  if (!date) throw new Error("target.date 蹇呭～");

  const toItem = (courtName, courtUid, time, cost) => {
    if (!courtName && !courtUid) throw new Error("courts[].court or courts[].courtUid is required");
    if (!time) throw new Error("time 蹇呭～(椤跺眰鎴栨瘡椤?");
    const uid = courtUid || uidByName[courtName] || courtName;
    const [h] = String(time).split(":");
    return {
      uid,
      begin: `${date} ${time}:00`,
      end: addMinutes(date, time, slotMinutes),
      cost: cost != null ? cost : 0,
    };
  };

  // 澶氬満鍦板舰鎬?
  if (Array.isArray(target.courts) && target.courts.length > 0) {
    return target.courts.map((c) => {
      if (typeof c === "string") {
        return toItem(c, null, target.time, target.cost);
      }
      return toItem(c.court, c.courtUid, c.time || target.time, c.cost != null ? c.cost : target.cost);
    });
  }

  // 鍗曞満鍦板舰鎬?鍚戝悗鍏煎)
  return [toItem(target.court, target.courtUid, target.time, target.cost)];
}

/**
 * 鍗曟鎶㈢エ璇锋眰 (璧伴鏋勫缓, 鏋佺畝璺緞, 鐢ㄤ簬楂樼簿搴﹂鍙戞垨閲嶈瘯)
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
 * 鎶㈢エ鍏ュ彛 (鍏煎鍘熺鍚? 鍏佽鐩存帴璋冪敤, 鍐呴儴璧?buildGrabRequest + fireOnce)
 * scheduler 楂樼簿搴︽ā寮忎細鐩存帴鐢?buildGrabRequest + fireOnce, 涓嶈蛋杩欓噷銆?
 */
export async function grab(target, cred) {
  const prebuilt = buildGrabRequest(target, cred);
  const { json } = await fireOnce(prebuilt);
  return interpretGrabResponse(json);
}

/** 瑙ｉ噴閾惰惫杩斿洖 */
export function interpretGrabResponse(json) {
  if (json && json.successed) {
    const res = json.result || {};
    if (res.script) {
      return {
        success: true,
        orderId: res.apptUid,
        message: "涓嬪崟鎴愬姛浣嗚繑鍥炲井淇℃敮浠樺弬鏁?浣欓鍙兘涓嶈冻), 闇€鎵嬪姩鏀粯",
        raw: json,
      };
    }
    return { success: true, orderId: res.apptUid, message: "鎶㈠埌骞跺凡浣欓鏀粯", raw: json };
  }
  return {
    success: false,
    message: (json && (json.message || JSON.stringify(json.messages) || `errorCode=${json.errorCode}`)) || "涓嬪崟澶辫触",
    raw: json,
  };
}

/** 楂樼簿搴﹂鍙? 鐢?scheduler 璋冪敤. 鍗曟鏋佺畝鍙戝皠(涓嶅惈閲嶈瘯, 閲嶈瘯鐢?scheduler 鎺? */
export async function fireGrab(prebuilt) {
  const { json } = await fireOnce(prebuilt);
  return interpretGrabResponse(json);
}

/** (鍙€? 鏌ヨ鏌愬ぉ鍙害鏃舵 */
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


export function classifyGrabResult(result) {
  if (result && result.success) return "success";
  const text = JSON.stringify(result || {}).toLowerCase();
  if (text.includes("操作太频繁") || text.includes("操作频繁") || text.includes("429")) return "rate-limited";
  if (text.includes("尚未放场") || text.includes("还没开场") || text.includes("未开放") || text.includes("超过可预约日期")) return "not-released";
  if (text.includes("timeout") || text.includes("aborted") || text.includes("econn") || text.includes("502") || text.includes("503")) return "transient";
  return "terminal";
}

export function discoverCapture(exchange) {
  let json = exchange && exchange.responseBody;
  if (typeof json === "string") { try { json = JSON.parse(json); } catch { return { courts: [] }; } }
  const slots = json && json.result && Array.isArray(json.result.slots) ? json.result.slots : [];
  const courts = new Map();
  for (const slot of slots) {
    const providerCourtId = String(slot.txtClassroomUid || slot.classroomUid || "");
    if (providerCourtId && !courts.has(providerCourtId)) courts.set(providerCourtId, { providerCourtId, name: slot.classRoomName || providerCourtId });
  }
  return { courts: [...courts.values()] };
}

export async function riskProbe(cred) {
  const probeDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const started = Date.now();
  try {
    await listSlots({ date: probeDate }, cred);
    return { ok: true, rateLimited: false, latencyMs: Date.now() - started, endpoint: "/wxapi/AppointmentVenue/LoadValidClassRoomApptSettingV2" };
  } catch (error) {
    const message = String(error.message || error);
    return { ok: false, rateLimited: message.includes("频繁") || message.includes("429"), latencyMs: Date.now() - started, message, endpoint: "/wxapi/AppointmentVenue/LoadValidClassRoomApptSettingV2" };
  }
}
export default { meta, riskProfile, ready, grab, preheat, buildGrabRequest, fireGrab, listSlots, interpretGrabResponse, classifyGrabResult, discoverCapture, riskProbe };

