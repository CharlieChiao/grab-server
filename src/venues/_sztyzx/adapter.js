/**
 * i深体(sztyzx.com.cn)球场适配器工厂 — 深圳体育中心旗下场馆通用平台。
 * 每个球场目录只写 venue.yml(orgId/sportscatId/groundtypeId/courts), 前海运动公园为首个接入。
 *
 * 契约(认证: Authorization: <JWT>, 有效期约 30 天, sub 为手机号):
 *   POST /module-stadium/stadiumSportscat/app/getSportscatGroundType  运动类别/可订天数(公开)
 *   POST /module-stadium/stadiumRoundInfo/list         场次明细(placeId × startTime, appointFlag/price)
 *   POST /module-order/order/add                       下单(建订单, 微信扫码支付, 10 分钟窗口)
 *   GET  /module-order/order/app/getOrderInfoByOrderId/{id}  订单详情(payTime/orderState)
 *   POST /module-order/order/app/list                  我的订单(登录探活/预约管理)
 */
import { Pool } from "undici";

export function createSztyzxAdapter(cfg, options = {}) {
  const B = cfg.backend;
  const APP = String(B.applicationId ?? "4");
  const sportscatName = B.sportscatName || "网球";

  const pool = new Pool(B.base, {
    connections: 4,
    pipelining: 1,
    keepAliveTimeout: 60 * 1000,
    keepAliveMaxTimeout: 10 * 60 * 1000,
    connect: { timeout: 8000 },
  });

  function headers(cred) {
    return {
      Authorization: String(cred?.Authorization || ""),
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.79",
    };
  }

  // JWT sub 是手机号, 下单 userPhone 用平台同款脱敏格式(156****8682)
  function maskedPhone(cred) {
    const sub = String(cred?.Authorization || "").split(".")[1] ? safeJwtSub(cred) : "";
    return sub ? `${sub.slice(0, 3)}****${sub.slice(-4)}` : "";
  }
  function safeJwtSub(cred) {
    try { return JSON.parse(Buffer.from(String(cred?.Authorization || "").split(".")[1], "base64").toString("utf8")).sub || ""; } catch { return ""; }
  }
  // 平台要求北京时间字符串 appTime: "YYYY-MM-DD HH:mm:ss"
  function beijingNow() {
    return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
  }

  async function request(method, path_, cred, payload, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const { statusCode, body } = await pool.request({ method, path: path_, headers: headers(cred), body: payload === undefined ? undefined : JSON.stringify(payload), signal: ctrl.signal });
      const text = await body.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: statusCode, json };
    } finally { clearTimeout(timer); }
  }
  const post = (p, cred, payload, t) => request("POST", p, cred, payload, t);
  const get = (p, cred, t) => request("GET", p, cred, undefined, t);

  const meta = { id: cfg.id, name: cfg.name, logo: cfg.logo || "", desc: cfg.desc || "", raw: cfg };
  const riskProfile = {
    scopeKey: `sztyzx:org:${B.orgId}`,
    booking: { minIntervalMs: 1500, jitterMs: 400, notReleasedIntervalMs: 2500, transientIntervalMs: 0, cooldownMs: 10000, maxRetry: 8 },
  };

  async function ready(cred) {
    if (!cred || !cred.Authorization) return { ok: false, detail: "缺少 Authorization(JWT)" };
    try {
      // 可订天数(公开接口, 不验 token); 登录探活用我的订单(需 token)
      const [daysRes, orderRes] = await Promise.all([
        post("/module-stadium/stadiumSportscat/app/getSportscatGroundType", cred, { orgId: String(B.orgId), publicType: 2, applicationId: APP }, 8000),
        post("/module-order/order/app/list", cred, { userId: "", orderState: [], orderCategory: [1, 2, 3, 4, 5, 6], operSource: 2, orgId: Number(B.orderOrgId) || B.orgId, fuzzySearch: "", tradeTypeList: [], queryLabel: "", parentOrderId: "", orderNumber: "", queryMaintype: "", pageNum: 1, pageSize: 1, serviceStartTime: "", serviceEndTime: "", isOnlyValidate: "", applicationId: APP }, 8000),
      ]);
      if (orderRes.status !== 200 || orderRes.json?.code !== "0") return { ok: false, detail: (orderRes.json && orderRes.json.msg) || `HTTP ${orderRes.status}` };
      const cat = (daysRes.json?.body || []).find((c) => String(c.sportscatId) === String(B.sportscatId)) || {};
      const advanceDays = Number(cat.normalAdvanceDays);
      return { ok: true, detail: `已登录${Number.isFinite(advanceDays) && advanceDays > 0 ? ` · 可订 ${advanceDays} 天` : ""}` };
    } catch (e) { return { ok: false, detail: String(e?.message || e) }; }
  }

  // 场次明细 → 统一 slot 形状(appointFlag=1 且有价视为可约; roundId/priceId 为下单必填项)
  async function listSlots(query, cred) {
    const { status, json } = await post("/module-stadium/stadiumRoundInfo/list", cred, {
      sportscatId: B.sportscatId, groundtypeId: B.groundtypeId, orgId: String(B.orgId),
      useDate: query.date, auditFlag: 3, qryPriceFlag: 1, isPriceEmpty: 1, publicType: 2, applicationId: APP,
    });
    if (status !== 200 || json?.code !== "0") throw new Error((json && json.msg) || `HTTP ${status}`);
    const aliasByUid = Object.fromEntries((cfg.courts || []).map((c) => [String(c.uid), c.name]));
    const slots = [];
    for (const r of json.body || []) {
      const price = Number(r.priceInfoList?.[0]?.price) || 0;
      const begin = String(r.useDate || query.date) + " " + String(r.startTime || "");
      const end = String(r.useDate || query.date) + " " + String(r.endTime || "");
      if (!/\d{2}:\d{2}/.test(begin)) continue;
      slots.push({
        uid: String(r.placeId),
        court: aliasByUid[String(r.placeId)] || r.placeName || r.roundName || r.placeId,
        begin, end,
        canAppoint: r.appointFlag === 1 && price > 0,
        cost: price,
        roundId: r.id,               // 下单 itemsId
        priceId: r.priceInfoList?.[0]?.id, // 下单 priceId
        remainnum: Number(r.priceInfoList?.[0]?.remainnum ?? 1),
      });
    }
    return slots;
  }

  // 下单: 先查场次拿 roundId/priceId → order/add 建订单(微信扫码支付, 复用待付款生命周期)
  async function grab(target, cred) {
    const { workidInfo, total } = await buildWorkid(target, cred, true);
    const { status, json } = await post("/module-order/order/add", cred, orderPayload(target, workidInfo, total, cred));
    if (status === 200 && json?.code === "0" && json.body?.id) {
      return {
        success: true,
        orderId: json.body.id,
        requiresManualPayment: true,
        message: `下单成功(¥${total})，请到小程序订单页扫码微信支付`,
        raw: json,
      };
    }
    return { success: false, message: (json && (json.msg || json.detail || `code=${json.code}`)) || `下单失败(HTTP ${status})`, raw: json };
  }

  // 匹配目标场次 → workidInfo(itemsId=roundId, priceId); checkAvail=false 供放场首发跳过可约检查(场馆拒绝为准)
  async function buildWorkid(target, cred, checkAvail) {
    const courts = Array.isArray(target.courts) && target.courts.length
      ? target.courts.map((c) => ({ uid: String(c.courtUid ?? ""), time: String(c.time || target.time || "") }))
      : [{ uid: String(target.courtUid ?? ""), time: String(target.time || "") }];
    if (!courts.length || !courts[0].uid || !courts[0].time) throw new Error("缺少场地或时段");
    const slots = await listSlots({ date: target.date }, cred);
    const workidInfo = courts.map((c) => {
      const slot = slots.find((s) => s.uid === c.uid && s.begin.slice(11, 16) === c.time);
      if (!slot) throw new Error(`未找到场次 ${c.uid} ${c.time}`);
      if (checkAvail && !slot.canAppoint) throw new Error(`场次不可预约(${slot.court} ${c.time})`);
      return { itemsId: slot.roundId, number: 1, priceId: slot.priceId, actualAmt: slot.cost, startTime: slot.begin.slice(11), endTime: slot.end.slice(11), userInfoList: [] };
    });
    const total = workidInfo.reduce((sum, w) => sum + Number(w.actualAmt || 0), 0);
    return { workidInfo, total };
  }

  function orderPayload(target, workidInfo, total, cred) {
    return {
      occupyType: 1, operType: 2, appointDate: target.date, groundTypeId: B.groundtypeId, orderCategory: 1,
      sellerOrgId: B.orgId, sportsCatId: B.sportscatId, payMethodList: [], tradeType: 7, assetsCode: [],
      discountPrice: 0, originalPrice: total, membercardId: "", membercardName: "",
      workidInfo, sportsType: B.sportsType,
      orderPriceInfo: { originalPrice: total, actualPrice: total },
      userPhone: maskedPhone(cred), memberUserId: "", deductionAssetsIds: [], isFriendPay: 1,
      appTime: beijingNow(), applicationId: APP,
    };
  }

  // 支付状态查询契约: payTime 有值=paid, orderState=1=pending(待支付), 其余=cancelled(超时自动取消)
  async function checkPaymentStatus(cred, result) {
    try {
      const orderId = result?.orderId || result?.raw?.body?.id;
      if (!orderId) return null;
      const { status, json } = await get(`/module-order/order/app/getOrderInfoByOrderId/${orderId}`, cred, 8000);
      if (status !== 200 || json?.code !== "0") return null;
      const b = json.body || {};
      if (b.payTime) return "paid";
      if (Number(b.orderState) === 1) return "pending";
      return "cancelled";
    } catch { return null; }
  }

  // 已约订单列表(预约管理契约): 列表 + 逐单详情组 items(每单一次 detail 查询)
  async function listMyBookings(cred) {
    const { status, json } = await post("/module-order/order/app/list", cred, { userId: "", orderState: [], orderCategory: [1, 2, 3, 4, 5, 6], operSource: 2, orgId: Number(B.orderOrgId) || B.orgId, fuzzySearch: "", tradeTypeList: [], queryLabel: "", parentOrderId: "", orderNumber: "", queryMaintype: "", pageNum: 1, pageSize: 20, serviceStartTime: "", serviceEndTime: "", isOnlyValidate: "", applicationId: APP });
    if (status !== 200 || json?.code !== "0") throw new Error((json && json.msg) || `HTTP ${status}`);
    const bookings = [];
    for (const o of json.body?.data || []) {
      let detail = o;
      try {
        const d = await get(`/module-order/order/app/getOrderInfoByOrderId/${o.id}`, cred, 8000);
        if (d.json?.code === "0" && d.json.body) detail = d.json.body;
      } catch {}
      if (!detail.serviceStartTime) continue;
      bookings.push({
        uid: String(o.id),
        createdAt: detail.orderTime || o.orderTime,
        status: detail.payTime ? "已支付" : "待支付",
        items: [{ court: detail.orderInfoList?.[0]?.roundName || o.orderNumber, begin: detail.serviceStartTime, end: detail.serviceEndTime, cost: Number(detail.orderAmt) || 0 }],
        amount: Number(detail.orderAmt) || 0,
        raw: { orderId: o.id, orderNumber: o.orderNumber },
      });
    }
    return bookings;
  }

  // 风控探测(riskCalibration 契约): 查 7 天前的场次(只读无副作用)
  async function riskProbe(cred) {
    const probeDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const started = Date.now();
    try {
      await listSlots({ date: probeDate }, cred);
      return { ok: true, rateLimited: false, latencyMs: Date.now() - started, endpoint: "/module-stadium/stadiumRoundInfo/list" };
    } catch (error) {
      const message = String(error.message || error);
      return { ok: false, rateLimited: /频繁|429|too many/i.test(message), latencyMs: Date.now() - started, message, endpoint: "/module-stadium/stadiumRoundInfo/list" };
    }
  }

  // 预构建下单请求(放场首发省一次查询 RTT)
  async function buildGrabRequest(target, cred) {
    const { workidInfo, total } = await buildWorkid(target, cred, false);
    const payload = orderPayload(target, workidInfo, total, cred);
    return { path: "/module-order/order/add", headers: headers(cred), body: JSON.stringify(payload) };
  }
  async function fireGrab(prebuilt) {
    const built = await prebuilt;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const { statusCode, body } = await pool.request({ method: "POST", path: built.path, headers: built.headers, body: built.body, signal: ctrl.signal });
      const text = await body.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (statusCode === 200 && json?.code === "0" && json.body?.id) {
        return { success: true, orderId: json.body.id, requiresManualPayment: true, message: "下单成功，请到小程序订单页扫码微信支付", raw: json };
      }
      return { success: false, message: (json && (json.msg || json.detail || `code=${json.code}`)) || `下单失败(HTTP ${statusCode})`, raw: json };
    } finally { clearTimeout(timer); }
  }

  // 失败原因声明: registry 据此构建 classifyFailure(scheduler 重试判定唯一入口)
  const failureReasons = {
    rules: [
      { kind: "rate_limited", patterns: ["频繁", "429", "too many"] },
      { kind: "transient", patterns: ["处理中", "稍后再试", "系统繁忙"] },
      { kind: "occupied", patterns: ["已被预约", "已约满", "已有预约"] },
      // inspectSlots: 失败后回查场次细分——未放场转 release-pending 走放场快重试/watch(放场时刻未校准, 0 点发射大概率被拒)
      { kind: "not_released", patterns: ["不可预约", "未找到场次", "已开始", "已满", "未开放", "提前"], inspectSlots: true },
      { kind: "payment", patterns: ["支付失败", "支付超时"] },
    ],
  };

  return {
    meta, riskProfile, ready, grab, listSlots, checkPaymentStatus, listMyBookings, riskProbe, buildGrabRequest, fireGrab, failureReasons,
    payments: { wechat: "wxpay" }, // 仅微信扫码支付(order/add 不带支付方式, 订单生成后扫码)
  };
}
