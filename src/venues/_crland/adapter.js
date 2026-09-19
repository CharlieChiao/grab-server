/**
 * 华润未来荟(crland)球场适配器工厂 — 通用平台, 每个球场目录只写 venue.yml(projectUuid + courts)。
 *
 * 契约(认证: Authorization: Wechat <JWT>, 一年有效):
 *   POST /business/client/field/area/matrix        场次矩阵(fieldList × matrix, isAbleReserve/price)
 *   POST /business/client/field/area/reserve       下单(建订单, 返回 orderPayUuid) — 支付仅 wxMini
 *   POST /order/client/order/pay/pre/create        拿微信支付参数(需 openid, 从 JWT 解码)
 *   POST /order/client/order/pay/cancel             取消支付(释放场次)
 *   POST /business/client/field/area/reserve/day   可订天数(ready 探活)
 *   POST /order/client/order/bus/detail             订单详情(单查)
 */
import { Pool } from "undici";
import { constants as cryptoConstants } from "node:crypto";

export function createCrlandAdapter(cfg) {
  const B = cfg.backend;
  const areaUuid = B.fieldAreaUuid; // 场地区域(网球/羽毛球/乒乓球), listSlots/grab 的区域标识
  const slotMinutes = Math.max(30, Number(cfg.bookingHours?.slotMinutes) || 60);

  const pool = new Pool(B.base, {
    connections: 4,
    pipelining: 1,
    keepAliveTimeout: 60 * 1000,
    keepAliveMaxTimeout: 10 * 60 * 1000,
    connect: {
      timeout: 8000,
      // 未来荟服务器为老式 TLS 配置(legacy renegotiation), OpenSSL3 默认拒绝握手, 需显式放行
      secureOptions: cryptoConstants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
    },
  });

  function headers(cred) {
    const token = String(cred?.Authorization || "");
    return {
      Authorization: token.startsWith("Wechat ") ? token : `Wechat ${token}`,
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50",
    };
  }
  function openidOf(cred) {
    try {
      const payload = JSON.parse(Buffer.from(String(cred?.Authorization || "").replace(/^Wechat\s+/i, "").split(".")[1], "base64").toString("utf8"));
      return payload.openid || payload.sub || "";
    } catch { return ""; }
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

  const meta = { id: cfg.id, name: cfg.name, logo: cfg.logo || "", desc: cfg.desc || "", raw: cfg };
  const riskProfile = {
    scopeKey: `crland:project:${B.projectUuid}`,
    booking: { minIntervalMs: 1500, jitterMs: 400, notReleasedIntervalMs: 2500, transientIntervalMs: 3000, cooldownMs: 10000, maxRetry: 8 },
  };

  async function ready(cred) {
    if (!cred || !cred.Authorization) return { ok: false, detail: "缺少 Authorization(Wechat JWT)" };
    try {
      const { status, json } = await post("/business/client/field/area/reserve/day", cred, { fieldAreaUuid: areaUuid, projectUuid: B.projectUuid }, 8000);
      if (status === 200 && json?.code === 200) return { ok: true, detail: `已登录 · 可订 ${json.result} 天` };
      return { ok: false, detail: (json && json.text) || `HTTP ${status}` };
    } catch (e) { return { ok: false, detail: String(e?.message || e) }; }
  }

  // 场次矩阵 → 统一 slot 形状(isAbleReserve 且 price>0 视为可约)
  async function listSlots(query, cred) {
    const { status, json } = await post("/business/client/field/area/matrix", cred, { fieldAreaUuid: areaUuid, reserveDate: query.date, enterpriseUuid: "", discountSpecUuid: "", projectUuid: B.projectUuid });
    if (status !== 200 || json?.code !== 200) throw new Error(json?.text || `HTTP ${status}`);
    const r = json.result || {};
    const nameByUuid = Object.fromEntries((r.fieldList || []).map((f) => [f.fieldUuid, f.fieldName]));
    // yml courts[].name 覆盖接口名(展示别名, 如"1号场深圳"); 未配置的场地保持接口返回名
    const aliasByUuid = Object.fromEntries((cfg.courts || []).map((c) => [String(c.uid), c.name]));
    const slots = [];
    for (const row of r.matrix || []) {
      for (const cell of row.matrix || []) {
        const begin = String(cell.startTime || "").replace(" ", "T");
        if (!/T\d{2}:\d{2}/.test(begin)) continue;
        slots.push({
          uid: String(cell.fieldUuid),
          court: aliasByUuid[String(cell.fieldUuid)] || nameByUuid[cell.fieldUuid] || cell.fieldUuid,
          fieldTimeUuid: String(cell.fieldTimeUuid || ""),
          begin: String(cell.startTime || ""),
          canAppoint: cell.isAbleReserve === true && Number(cell.price) > 0,
          cost: Number(cell.price) || 0,
        });
      }
    }
    return slots;
  }

  // 下单两步: reserve 建订单 → pay/pre/create 拿微信支付参数(requiresManualPayment)
  async function grab(target, cred) {
    const courts = Array.isArray(target.courts) && target.courts.length
      ? target.courts.map((c) => ({ uid: String(c.courtUid ?? ""), time: String(c.time || target.time || "") }))
      : [{ uid: String(target.courtUid ?? ""), time: String(target.time || "") }];
    if (!courts.length || !courts[0].uid || !courts[0].time) throw new Error("缺少场地或时段");
    // 实时查矩阵拿 fieldTimeUuid(下单必填)
    const slots = await listSlots({ date: target.date }, cred);
    const infos = courts.map((c) => {
      const slot = slots.find((s) => s.uid === c.uid && s.begin.slice(11, 16) === c.time);
      if (!slot) throw new Error(`未找到场次 ${c.uid} ${c.time}`);
      if (!slot.canAppoint) throw new Error(`场次不可预约(${slot.court} ${c.time})`);
      return { fieldUuid: c.uid, fieldTimeUuid: slot.fieldTimeUuid, wholeFieldUuid: c.uid };
    });
    const { status, json } = await post("/business/client/field/area/reserve", cred, {
      payment: String((target.ext && target.ext.payMethod) || "wxMini"),
      reserveDate: target.date,
      fieldTimeInfos: infos,
      couponAssignUuid: (target.ext && target.ext.couponAssignUuid) || "",
      enterpriseUuid: "",
      discountSpecUuid: "",
      checkReserveUuid: "",
      projectUuid: B.projectUuid,
    });
    if (status === 200 && json?.code === 200 && json.result?.orderPayUuid) {
      const d = json.result;
      // 第二步: 拿微信支付参数(openid 从 JWT 解码)
      let payElements = null;
      try {
        const pay = await post("/order/client/order/pay/pre/create", cred, { orderPayUuid: d.orderPayUuid, openid: openidOf(cred), projectUuid: B.projectUuid });
        if (pay.json?.result?.paymentElements) payElements = pay.json.result.paymentElements;
      } catch {}
      return {
        success: true,
        orderId: d.orderPayUuid, // orderPayUuid 即取消支付的凭据, 兼作订单标识
        requiresManualPayment: true, // 仅微信支付, 复用待付款生命周期
        message: `下单成功(¥${d.subTotal})，等待微信支付`,
        raw: { code: 200, result: { ...d, paymentElements: payElements } },
      };
    }
    return { success: false, message: (json && (json.text || json.message || `code=${json.code}`)) || `下单失败(HTTP ${status})`, raw: json };
  }

  // 取消(取消支付即释放场次); uid 为下单返回的 orderPayUuid
  async function cancelBooking(cred, orderPayUuid) {
    const { status, json } = await post("/order/client/order/pay/cancel", cred, { orderPayUuid: String(orderPayUuid), projectUuid: B.projectUuid });
    if (status === 200 && json?.code === 200) return { ok: true };
    return { ok: false, error: (json && (json.text || json.message)) || `取消失败(HTTP ${status})` };
  }

  // 订单详情(单查); 列表端点未捕获, 暂以 detail 兜 listMyBookings 契约的空实现
  function classifyGrabResult(result) {
    if (result?.success === true) return "success";
    const message = String(result?.message || "");
    if (/频繁|429|too many/i.test(message)) return "rate-limited";
    if (/不可预约|已开始|已被|已满|isAbleReserve/i.test(message)) return "not-released";
    return "terminal";
  }

  return {
    meta, riskProfile, ready, grab, listSlots, cancelBooking, classifyGrabResult,
    payments: { wechat: "wxMini" },
  };
}
