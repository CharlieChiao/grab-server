/**
 * 爱拍客(aipaike)球场适配器工厂 — 通用 REST 平台, 同一 API 可服务多家门店(storeId 不同)。
 * 每个球场目录只写 venue.yml(backend.storeId + courts) + 薄 index.js 调用本工厂。
 *
 * REST 契约(全部 Bearer JWT 认证):
 *   GET  /venue-availability-grid?date=&storeId=   场次网格(timeRows × cells[venueId][], status: free/occupied/training_reserved)
 *   POST /venue-bookings {venueId,date,startTime,endTime,userCouponId?,paymentMethod}  下单(微信锁场, 响应带 wechatPayParams)
 *   GET  /venue-bookings                            已约列表
 *   DELETE /venue-bookings/:bookingId               取消(释放场次)
 *   GET  /membership/summary                        会员/余额
 */
import { Pool } from "undici";
import { setCredential } from "../../core/credentialStore.js";
import { createKeyedSingleFlight } from "../../core/singleFlight.js";

export function createAipaikeAdapter(cfg) {
  const B = cfg.backend;
  const API = "/api/v1/student";
  const slotMinutes = Math.max(30, Number(cfg.bookingHours?.slotMinutes) || 30);

  const pool = new Pool(B.base, {
    connections: 4,
    pipelining: 1,
    keepAliveTimeout: 60 * 1000,
    keepAliveMaxTimeout: 10 * 60 * 1000,
    connect: { timeout: 8000 },
  });

  function headers(cred) {
    const token = String(cred?.Authorization || "");
    return {
      Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      "X-Active-Store-Id": String(B.storeId),
      ...(B.clubId ? { "X-Active-Club-Id": String(B.clubId) } : {}), // 平台必带头(缺省报 MISSING_ACTIVE_CLUB)
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50",
    };
  }

  async function request(method, path_, cred, payload, timeoutMs = 12000, isRetry = false) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let statusCode, text;
    try {
      const r = await pool.request({ method, path: path_, headers: headers(cred), body: payload === undefined ? undefined : JSON.stringify(payload), signal: ctrl.signal });
      statusCode = r.statusCode;
      text = await r.body.text();
    } finally { clearTimeout(timer); }
    let json = null;
    try { json = JSON.parse(text); } catch {}
    // access token 过期(401/UNAUTHORIZED): 用 refreshToken 自动续期(轮换), 回写凭证库后重试一次
    if (statusCode === 401 && !isRetry && cred?.refreshToken && !path_.includes("/auth/refresh")) {
      const refreshed = await tryRefresh(cred);
      if (refreshed) return request(method, path_, refreshed, payload, timeoutMs, true);
    }
    return { status: statusCode, json };
  }

  // 按账号单飞刷新: 同账号并发 401 共用一次 refresh, 不同账号互不共享 token。
  const runRefresh = createKeyedSingleFlight({ lingerMs: 50 });
  async function tryRefresh(cred) {
    const accountKey = cred?._userId
      ? `user:${cred._userId}`
      : `refresh:${String(cred?.refreshToken || "")}`;
    return runRefresh(accountKey, async () => {
        try {
          const r = await fetch(B.base + "/api/v1/auth/refresh", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Active-Store-Id": String(B.storeId),
              ...(B.clubId ? { "X-Active-Club-Id": String(B.clubId) } : {}),
            },
            body: JSON.stringify({ refreshToken: cred.refreshToken }),
          });
          const j = await r.json().catch(() => null);
          if (r.status !== 200 || j?.code !== 0 || !j.data?.token) return null;
          const next = { ...cred, Authorization: `Bearer ${j.data.token}`, refreshToken: j.data.refreshToken || cred.refreshToken };
          // 回写凭证库(滚动保存轮换后的 refresh token); 元数据字段不落库
          if (cred._venueId && cred._userId) {
            const { _venueId, _userId, ...persist } = next;
            setCredential(_venueId, persist, _userId);
          }
          console.log(`[aipaike:${cfg.id}] token auto-refreshed (access 2h, refresh token rotated)`);
          return next;
        } catch (e) {
          console.warn(`[aipaike:${cfg.id}] refresh failed: ${String(e?.message || e)}`);
          return null;
        }
    });
  }
  const post = (p, cred, payload, t) => request("POST", p, cred, payload, t);
  const get = (p, cred, t) => request("GET", p, cred, undefined, t);
  const del = (p, cred, t) => request("DELETE", p, cred, undefined, t);

  const meta = { id: cfg.id, name: cfg.name, logo: cfg.logo || "", desc: cfg.desc || "", raw: cfg };
  const riskProfile = {
    scopeKey: `aipaike:store:${B.storeId}`,
    booking: { minIntervalMs: 1500, jitterMs: 400, notReleasedIntervalMs: 2500, transientIntervalMs: 3000, cooldownMs: 10000, maxRetry: 8 },
  };

  async function ready(cred) {
    if (!cred || !cred.Authorization) return { ok: false, detail: "缺少 Authorization(Bearer JWT)" };
    try {
      const { status, json } = await get(`${API}/membership/summary`, cred, 8000);
      if (status === 200 && json?.code === 0) {
        const balance = Number(json.data?.balance);
        const parts = [];
        if (Number.isFinite(balance) && balance > 0) parts.push(`余额 ¥${balance}`);
        if (json.data?.isMember) parts.push("会员");
        return { ok: true, detail: parts.join(" · ") || "已登录", extra: { balance, windowDays: json.data?.windowDays } };
      }
      return { ok: false, detail: (json && json.message) || `HTTP ${status}` };
    } catch (e) { return { ok: false, detail: String(e?.message || e) }; }
  }

  // 场次网格 → 统一 slot 形状; status: free=可约(其余 occupied/training_reserved 不可约)
  async function listSlots(query, cred) {
    const { status, json } = await get(`${API}/venue-availability-grid?date=${query.date}&storeId=${B.storeId}`, cred);
    if (status !== 200 || json?.code !== 0) throw new Error(json?.message || `HTTP ${status}`);
    const data = json.data || {};
    const nameByUid = Object.fromEntries((data.venues || []).map((v) => [v.id, v.name]));
    const slots = [];
    const statusMessage = { occupied: "已被预约", training_reserved: "已被排课", locked: "已被锁场", not_released: "尚未放场" };
    for (const cells of Object.values(data.cells || {})) {
      for (const cell of cells || []) {
        slots.push({
          uid: String(cell.venueId),
          court: nameByUid[cell.venueId] || cell.venueId,
          begin: `${query.date} ${cell.start}:00`,
          canAppoint: cell.status === "free",
          slotStatus: cell.status,
          message: cell.message || cell.reason || statusMessage[cell.status] || cell.status,
          cost: Number(cell.price) || 0,
        });
      }
    }
    return slots;
  }

  // 目标 → 单笔下单参数: 该平台一单 = 一个场地的连续时段; 多场地/不连续报错
  function buildBookingPayload(target) {
    const wanted = Array.isArray(target.courts) && target.courts.length
      ? target.courts.map((c) => ({ uid: String(c.courtUid ?? ""), time: String(c.time || target.time || "") }))
      : [{ uid: String(target.courtUid ?? ""), time: String(target.time || "") }];
    if (!wanted.length || !wanted[0].uid || !wanted[0].time) throw new Error("缺少场地或时段");
    if (new Set(wanted.map((w) => w.uid)).size > 1) throw new Error("该球场一单只能订同一场地的连续时段");
    const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    const startMin = toMin(wanted[0].time);
    const span = wanted.length * slotMinutes;
    const endMin = startMin + span;
    if (wanted.length > 1) {
      wanted.forEach((w, i) => {
        if (toMin(w.time) !== startMin + i * slotMinutes) throw new Error("该球场一单只能订连续时段");
      });
    }
    const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    return {
      venueId: wanted[0].uid,
      date: target.date,
      startTime: fmt(startMin),
      endTime: fmt(endMin), // 24:00 为平台跨午夜表示, 原样保留
      paymentMethod: String((target.ext && target.ext.payMethod) || "wechat"),
    };
  }

  async function grab(target, cred) {
    const payload = buildBookingPayload(target);
    if (target.ext?.userCouponId) payload.userCouponId = target.ext.userCouponId;
    const { status, json } = await post(`${API}/venue-bookings`, cred, payload);
    if (status === 200 && json?.code === 0 && json.data?.bookingId) {
      const d = json.data;
      return {
        success: true,
        orderId: d.orderId || d.bookingId,
        bookingId: d.bookingId,
        requiresManualPayment: !!d.wechatPayParams, // 微信锁场 → 人工付款(复用待支付生命周期)
        message: d.wechatPayParams ? "下单成功，等待微信支付" : `下单成功(¥${d.finalAmount ?? d.totalAmount})`,
        raw: json,
      };
    }
    return { success: false, message: (json && (json.message || `code=${json.code}`)) || `下单失败(HTTP ${status})`, raw: json };
  }

  async function listMyBookings(cred) {
    const { status, json } = await get(`${API}/venue-bookings?scope=all&status=upcoming&page=1&pageSize=20`, cred);
    if (status !== 200 || json?.code !== 0) throw new Error(json?.message || `HTTP ${status}`);
    const list = (json.data && json.data.list) || [];
    return list.map((b) => ({
      uid: String(b.bookingId || b.id),
      amount: Number(b.finalAmount ?? b.totalAmount ?? 0) || 0,
      payStatus: b.orderStatus,
      status: b.status,
      createdAt: b.createdAt,
      payments: Array.isArray(b.paymentTimeline) ? b.paymentTimeline.map((p) => ({ code: p.method, name: p.method, amount: Number(p.amount) || 0 })) : [],
      items: (b.items || (b.venueName ? [{ venueName: b.venueName, date: b.date, startTime: b.startTime, endTime: b.endTime }] : [])).map((it) => ({
        court: it.venueName || it.venueId || "",
        begin: it.date && it.startTime ? `${it.date} ${it.startTime}` : it.startTime || "",
        end: it.endTime || "",
        cost: Number(it.amount) || 0,
      })),
    }));
  }

  async function cancelBooking(cred, bookingId) {
    const { status, json } = await del(`${API}/venue-bookings/${encodeURIComponent(bookingId)}`, cred);
    if (status === 200 && json?.code === 0) return { ok: true };
    return { ok: false, error: (json && (json.message || `code=${json.code}`)) || `取消失败(HTTP ${status})` };
  }

  const failureReasons = {
    rules: [
      { kind: "rate_limited", classification: "rate-limited", retryable: true, patterns: [/频繁|frequen|too many/i], codes: [429] },
      { kind: "scheduled", terminal: true, slotStatuses: ["training_reserved"], patterns: [/排课|training_reserved/i] },
      { kind: "locked", terminal: true, slotStatuses: ["locked"], patterns: [/锁场|locked/i] },
      { kind: "occupied", terminal: true, slotStatuses: ["occupied", "full"], patterns: [/已被预约|已被预定|occupied|已占用|已满|booked/i] },
      { kind: "not_released", classification: "not-released", retryable: true, slotStatuses: ["not_released"], patterns: [/尚未放场|未开放|not.?released/i] },
      { kind: "payment", terminal: true, patterns: [/余额不足|支付方式不可用|支付失败|insufficient.*balance|payment.*failed/i] },
      { kind: "unavailable", inspectSlots: true, patterns: [/不可预约|不可约|无效时段|unavailable/i] },
      { kind: "transient", classification: "transient", retryable: true, patterns: [/超时|timeout|aborted|econn|HTTP 50[23]/i] },
    ],
  };

  return {
    meta, riskProfile, ready, grab, listSlots, listMyBookings, cancelBooking, failureReasons,
    payments: { wechat: "wechat" },
  };
}
