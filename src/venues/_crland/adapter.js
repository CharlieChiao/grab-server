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
import fs from "node:fs";
import yaml from "js-yaml";

export function createCrlandAdapter(cfg, options = {}) {
  const B = cfg.backend;
  const venueFile = options.venueFile; // saveRetryCalibration 回写配置用
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
    booking: { minIntervalMs: 1500, jitterMs: 400, notReleasedIntervalMs: 2500, transientIntervalMs: 300, cooldownMs: 10000, maxRetry: 8 },
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

  // 支付状态查询契约: 轮询/超时判定前确认订单真实状态, 避免"已付款仍判失败"或"已取消傻等超时"
  // 返回 "paid"(orderStatus=PAID) / "cancelled"(orderStatus=CANCELLED) / "pending"(待支付) / null(查询失败, 调用方按原逻辑处理)
  // 注意: 查询必须用任务下单时的同一凭证(订单 owner), 凭证不匹配时 detail 报"无权查看"——此时不可武断判定, 返回 null
  async function checkPaymentStatus(cred, result) {
    try {
      const orderUuid = result?.raw?.result?.orderBusUuid || result?.raw?.orderBusUuid;
      if (!orderUuid) return null;
      const { status, json } = await post("/order/client/order/bus/detail", cred, { orderUuid, projectUuid: B.projectUuid }, 8000);
      if (status !== 200 || json?.code !== 200) return null;
      const s = String(json.result?.orderStatus || "");
      if (/CANCEL/i.test(s)) return "cancelled";
      if (/PAID|COMPLETE|FINISH/i.test(s)) return "paid";
      return "pending";
    } catch { return null; }
  }

  // 已约场地列表(预约管理契约): check/reserve/index 按订单(orderBusUuid)分组, 每条含场次明细与核销码
  async function listMyBookings(cred) {
    const { status, json } = await post("/business/client/check/reserve/index", cred, { pageNum: 1, pageSize: 100, statusView: "待使用", isWholeCheck: true, projectUuid: B.projectUuid });
    if (status !== 200 || json?.code !== 200) throw new Error(json?.text || `HTTP ${status}`);
    const byOrder = new Map();
    for (const r of json.result?.data || []) {
      const key = String(r.orderBusUuid || r.checkReserveUuid || "");
      if (!key) continue;
      if (!byOrder.has(key)) byOrder.set(key, { uid: key, createdAt: r.creationDate, status: r.statusView, items: [], raw: { orderPayUuid: r.orderPayUuid, verifyCodes: [] } });
      const b = byOrder.get(key);
      b.items.push({ court: r.fieldName, begin: r.reserveStartTime, end: r.reserveEndTime, cost: Number(r.subTotal) || 0 });
      b.amount = Number(r.orderBusSubTotal) || b.items.reduce((s, it) => s + it.cost, 0);
      if (r.verifyCode && !b.raw.verifyCodes.includes(r.verifyCode)) b.raw.verifyCodes.push(r.verifyCode);
    }
    return [...byOrder.values()];
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
    if (/正在处理|处理中|稍后/i.test(message)) return "transient"; // 场次处理锁(放场高峰并发), 短间隔重试可成功
    if (/不可预约|已开始|已被|已满|isAbleReserve/i.test(message)) return "not-released";
    return "terminal";
  }

  // 失败原因声明: registry 据此构建 classifyFailure 并装饰 grab 结果(scheduler 重试判定唯一入口)。
  // 未声明时 grab 结果不带 failure 字段, scheduler 回退关键词分类(只认 429/transient 标志) → "正在处理"被误判 terminal 不重试。
  const failureReasons = {
    rules: [
      { kind: "rate_limited", patterns: ["频繁", "429", "too many"] },
      { kind: "transient", patterns: ["正在处理", "处理中", "稍后再试", "系统繁忙"] }, // 场次处理锁(放场高峰并发), 短间隔重试可成功
      { kind: "not_released", patterns: ["不可预约", "已开始", "已被", "已满", "未开放", "提前"] },
      { kind: "payment", patterns: ["支付方式只能是", "支付失败", "余额不足"] },
    ],
  };

  // 风控探测(riskCalibration 契约): 查 7 天前的场次矩阵(只读无副作用), 供二分校准最小安全间隔
  async function riskProbe(cred) {
    const probeDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const started = Date.now();
    try {
      await listSlots({ date: probeDate }, cred);
      return { ok: true, rateLimited: false, latencyMs: Date.now() - started, endpoint: "/business/client/field/area/matrix" };
    } catch (error) {
      const message = String(error.message || error);
      return { ok: false, rateLimited: /频繁|429|too many/i.test(message), latencyMs: Date.now() - started, message, endpoint: "/business/client/field/area/matrix" };
    }
  }

  // 用预构建 headers 直接发请求(fireGrab 用; 与 request() 的差别是不再从 cred 组装头)
  async function rawPost(path_, headerMap, bodyStr, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const { statusCode, body } = await pool.request({ method: "POST", path: path_, headers: headerMap, body: bodyStr, signal: ctrl.signal });
      const text = await body.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: statusCode, json };
    } finally { clearTimeout(timer); }
  }

  // 预构建下单请求(放场首发/重试校准共用): 提前查矩阵锁定 fieldTimeUuid, 到点直接发射省一次查询 RTT
  async function buildGrabRequest(target, cred) {
    const courts = Array.isArray(target.courts) && target.courts.length
      ? target.courts.map((c) => ({ uid: String(c.courtUid ?? ""), time: String(c.time || target.time || "") }))
      : [{ uid: String(target.courtUid ?? ""), time: String(target.time || "") }];
    if (!courts.length || !courts[0].uid || !courts[0].time) throw new Error("缺少场地或时段");
    const slots = await listSlots({ date: target.date }, cred);
    const infos = courts.map((c) => {
      const slot = slots.find((s) => s.uid === c.uid && s.begin.slice(11, 16) === c.time);
      if (!slot) throw new Error(`未找到场次 ${c.uid} ${c.time}`);
      // 不检查 canAppoint: 预构建请求发向不可约场次由场馆拒绝(重试校准依赖此行为), 正常任务用 grab() 自带检查
      return { fieldUuid: c.uid, fieldTimeUuid: slot.fieldTimeUuid, wholeFieldUuid: c.uid };
    });
    const payload = {
      payment: String((target.ext && target.ext.payMethod) || "wxMini"),
      reserveDate: target.date,
      fieldTimeInfos: infos,
      couponAssignUuid: (target.ext && target.ext.couponAssignUuid) || "",
      enterpriseUuid: "",
      discountSpecUuid: "",
      checkReserveUuid: "",
      projectUuid: B.projectUuid,
    };
    return { path: "/business/client/field/area/reserve", headers: headers(cred), body: JSON.stringify(payload), usesTimeCard: false };
  }

  // 发射预构建请求; prebuilt 兼容 Promise(releaseProbe 的 buildGrabRequest 调用不 await)
  async function fireGrab(prebuilt) {
    const built = await prebuilt;
    const { status, json } = await rawPost(built.path, built.headers, built.body);
    if (status === 200 && json?.code === 200 && json.result?.orderPayUuid) {
      return { success: true, orderId: json.result.orderPayUuid, requiresManualPayment: true, message: `下单成功(¥${json.result.subTotal})，等待微信支付`, raw: json };
    }
    return { success: false, message: (json && (json.text || json.message || `code=${json.code}`)) || `下单失败(HTTP ${status})`, raw: json };
  }

  // 重试校准结果持久化(releaseProbe 契约): 回写 yml 的 releaseRetry.fastRetry
  function saveRetryCalibration(calibration) {
    if (!venueFile) return null;
    const fresh = yaml.load(fs.readFileSync(venueFile, "utf8"));
    fresh.releaseRetry = fresh.releaseRetry || {};
    fresh.releaseRetry.fastRetry = { ...(fresh.releaseRetry.fastRetry || {}), minIntervalMs: Number(calibration.extraWaitMs || 0), jitterMs: Number(fresh.releaseRetry.fastRetry?.jitterMs || 30), calibration: { ...calibration } };
    fs.writeFileSync(venueFile, yaml.dump(fresh, { lineWidth: -1, noRefs: true }), "utf8");
    cfg.releaseRetry = fresh.releaseRetry;
    meta.raw.releaseRetry = fresh.releaseRetry;
    return fresh.releaseRetry.fastRetry;
  }

  return {
    meta, riskProfile, ready, grab, listSlots, cancelBooking, checkPaymentStatus, listMyBookings, classifyGrabResult, riskProbe, buildGrabRequest, fireGrab, saveRetryCalibration, failureReasons,
    payments: { wechat: "wxMini" },
  };
}
