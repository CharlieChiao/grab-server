/**
 * 银豹(Pospal)球场适配器工厂 — 同一银豹网关可服务多家店铺(storeId/projectUid 不同)。
 * 每个店铺目录只写 venue.yml + 薄 index.js 调用本工厂, 逻辑零复制。
 *
 * 高精度抢购设计:
 *  - undici keep-alive Pool 复用 TCP/TLS 连接(避免首发握手成本)
 *  - preheat(): 抢购前主动建连 + 一次轻量请求预热
 *  - buildGrabRequest(): 预构建请求 URL/headers/body, 到点直接 dispatch
 */
import fs from "node:fs";
import yaml from "js-yaml";
import { Pool } from "undici";

export function createPospalAdapter(cfg, options = {}) {
  const B = cfg.backend;
  const venueFile = options.venueFile; // saveRetryCalibration 回写配置用

  const pool = new Pool(B.base, {
    connections: 8,
    pipelining: 1,
    keepAliveTimeout: 60 * 1000,
    keepAliveMaxTimeout: 10 * 60 * 1000,
    connect: { timeout: 8000 },
  });

  function headers(cred) {
    return {
      PSPLVISITORAUTO: "API",
      VERSIONINFO: "NC|2026.04.16",
      STOREID: String(B.storeId),
      xweb_xhr: "1",
      APPTYPE: "3",
      POSPALSTOREMODE: "RegularOrder|takeout",
      PSPLVISITORID: cred.PSPLVISITORID,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541c1a) XWEB/25297",
      "Content-Type": "application/json",
      Accept: "*/*",
      Referer: "https://servicewechat.com/wx080059a4923a736f/2/page-frame.html",
    };
  }

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
  const slotEndOffsetMinutes = Number((cfg.bookingHours || {}).slotEndOffsetMinutes) || 0;
  const releaseRetry = cfg.releaseRetry || {};

  function addMinutes(date, time, minutes) {
    const [year, month, day] = String(date).split("-").map(Number);
    const [hour, minute] = String(time).split(":").map(Number);
    const result = new Date(Date.UTC(year, month - 1, day, hour, minute) + minutes * 60 * 1000);
    const pad = (value) => String(value).padStart(2, "0");
    return `${result.getUTCFullYear()}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())} ${pad(result.getUTCHours())}:${pad(result.getUTCMinutes())}:00`;
  }

  const meta = {
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

  const riskProfile = {
    scopeKey: `pospal:store:${B.storeId}`,
    mode: "serial-linear-backoff",
    calibration: { ...releaseRetry.calibration, blackoutMinutes: Number(releaseRetry.calibration?.blackoutMinutes || 30) },
    booking: {
      minIntervalMs: Number(releaseRetry.defaultMinIntervalMs || 3000),
      jitterMs: Number(releaseRetry.jitterMs || 300),
      cooldownMs: 10000,
      maxRetry: 40,
      notReleasedIntervalMs: 3000,
      transientIntervalMs: 3000,
      increaseStepMs: 500,
      cooldownStepMs: 5000,
    },
  };

  async function ready(cred) {
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
          const extra = { balance: json.balance, uid: json.uid };
          // 次卡(时段卡)余额: 与登录校验并行不阻塞, 失败静默(卡券信息缺失不影响凭证有效性判定)
          try {
            const cards = await loadTimeCards(cred);
            const active = cards.filter((c) => c.status === 1 && Number(c.times) > 0);
            if (active.length) {
              const totalTimes = active.reduce((s, c) => s + (Number(c.times) || 0), 0);
              extra.timeCards = active.map((c) => ({ uid: c.uidTxt || String(c.uid), number: c.number, times: Number(c.times) || 0, validUntil: c.avaliableEndTime }));
              extra.timeCardTimes = totalTimes;
            }
          } catch {}
          const balanceParts = [];
          if (Number.isFinite(Number(json.balance))) balanceParts.push(`余额 ¥${json.balance}`);
          if (extra.timeCardTimes) balanceParts.push(`次卡 ${extra.timeCardTimes} 次`);
          return {
            ok: true,
            detail: balanceParts.join(" · ") || "已登录",
            extra,
          };
        }
      } catch (e) {
        last = { error: String(e) };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, detail: "登录状态无效，PSPLVISITORID 可能已过期，需要重新抓取", extra: last || {} };
  }

  // 次卡(时段卡)查询: /wxapi/VenueTimeCard/LoadCustomerVenueTimeCard, 空 body 仅凭 PSPLVISITORID
  async function loadTimeCards(cred) {
    const { json } = await post("/wxapi/VenueTimeCard/LoadCustomerVenueTimeCard", cred, {});
    return (json && json.result) || [];
  }

  // 已约场地列表(归一化: 预约 uid/总额/支付明细/场次/创建时间)
  async function listMyBookings(cred) {
    const { json } = await post("/wxapi/AppointmentVenue/LoadVenueAppts", cred, { pageSize: 20, apptStatusType: 1, beginRow: 0, includeAllUserId: true, userIds: [] });
    const appts = (json && json.result && json.result.venueAppts) || [];
    return appts.map((a) => ({
      uid: a.txtUid || String(a.uid),
      amount: Number(a.appointAmount) || 0,
      payStatus: a.payStatus, status: a.status,
      createdAt: a.createdDatetime,
      payments: (a.apptPayments || []).map((p) => ({ code: p.payMethodCode, name: p.payMethodName || "", amount: Number(p.amount) || 0, timeCardUid: p.venueTimeCardUid ? String(p.venueTimeCardUid) : null })),
      items: (a.apptClassroomItems || []).map((it) => ({
        court: it.classroomName || (it.serviceClassroom || {}).name || "",
        begin: it.beginDatetime, end: it.endDatetime,
        cost: Number(it.totalCost) || 0,
      })),
    }));
  }

  // 按场次查可用次卡并自动选卡(次数刚够的优先用完, 同数取最早过期), 下单前由上层调用注入 ext.venueTimeCardUid
  async function pickTimeCard(cred, classroomItems) {
    const { json } = await post("/wxapi/AppointmentVenue/LoadCustomerVenueTimeCards", cred, { userId: B.storeId, classroomItems });
    const cards = (json && json.result) || [];
    const need = Math.max(1, (classroomItems || []).length);
    const usable = cards.filter((c) => c.status === 1 && Number(c.times) >= need);
    usable.sort((a, b) => (Number(a.times) - Number(b.times)) || (String(a.avaliableEndTime).localeCompare(String(b.avaliableEndTime))));
    return usable[0] || null;
  }

  // 支付准备契约: 下单前异步注入支付所需字段(次卡 → venueTimeCardUid); 非次卡支付原样透传。
  // scheduler 在预构建请求前调用; 抛错(无可用卡)按下单失败处理
  async function prepareTarget(target, cred) {
    if (B.payMethodTimeCard == null) return target;
    if (Number(target.ext?.payMethod) !== Number(B.payMethodTimeCard)) return target;
    if (target.ext.venueTimeCardUid) return target;
    const items = normalizeItems(target).map((it) => ({ classroomUid: it.uid, beginDatetime: it.begin, endDatetime: it.end }));
    const card = await pickTimeCard(cred, items);
    if (!card) throw new Error("没有可用的场地次卡(次数不足或已过期)");
    return { ...target, ext: { ...target.ext, venueTimeCardUid: card.uidTxt || String(card.uid) } };
  }

  // 取消预约(整单取消全部场次)
  async function cancelBooking(cred, apptUid) {
    const { json } = await post("/wxapi/AppointmentVenue/CancelVenueApptAllItem", cred, { apptUid: String(apptUid), userId: B.storeId });
    if (json && json.successed) return { ok: true };
    return { ok: false, error: (json && (json.message || JSON.stringify(json.messages))) || "取消失败" };
  }

  async function preheat(cred) {
    if (!cred || !cred.PSPLVISITORID) return { ok: false, detail: "缺少 PSPLVISITORID" };
    try {
      const t0 = Date.now();
      await post("/wxapi/customeraccount/FindLoginInfo", cred, { storeId: B.storeId, isRefresh: false }, 5000);
      return { ok: true, detail: `预热完成，耗时 ${Date.now() - t0}ms` };
    } catch (e) {
      return { ok: false, detail: "预热失败：" + String(e) };
    }
  }

  function normalizeItems(target) {
    const date = target.date;
    if (!date) throw new Error("target.date 必填");
    const toItem = (courtName, courtUid, time, cost) => {
      if (!courtName && !courtUid) throw new Error("courts[].court or courts[].courtUid is required");
      if (!time) throw new Error("time 必填（顶层或每一项）");
      const uid = courtUid || uidByName[courtName] || courtName;
      return {
        uid,
        begin: `${date} ${time}:00`,
        end: addMinutes(date, time, slotMinutes + slotEndOffsetMinutes),
        cost: cost != null ? cost : 0,
      };
    };
    if (Array.isArray(target.courts) && target.courts.length > 0) {
      return target.courts.map((c) => {
        if (typeof c === "string") {
          return toItem(c, null, target.time, target.cost);
        }
        return toItem(c.court, c.courtUid, c.time || target.time, c.cost != null ? c.cost : target.cost);
      });
    }
    return [toItem(target.court, target.courtUid, target.time, target.cost)];
  }

  function buildGrabRequest(target, cred) {
    const items = normalizeItems(target);
    const explicitTotal = Number(target.ext && target.ext.totalCost);
    const totalCost = Number.isFinite(explicitTotal) && explicitTotal > 0
      ? explicitTotal
      : items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
    const payMethod = (target.ext && target.ext.payMethod) || B.payMethodBalance;
    // 次卡支付: 官方小程序形态 paymentMethod+venueTimeCardUid(金额 0, combinationPayments 为空);
    // 其余支付(余额/微信)走 combinationPayments 明细
    const useTimeCard = B.payMethodTimeCard != null && Number(payMethod) === Number(B.payMethodTimeCard);
    if (useTimeCard && !(target.ext && target.ext.venueTimeCardUid)) throw new Error("次卡支付缺少 venueTimeCardUid");
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
      ...(useTimeCard
        ? { paymentMethod: B.payMethodTimeCard, venueTimeCardUid: String(target.ext.venueTimeCardUid), combinationPayments: [] }
        : { combinationPayments: [{ paymentMethod: payMethod, cost: totalCost }] }),
    };
    return {
      path: "/wxapi/AppointmentVenue/SaveVenueAppointmentV2",
      headers: headers(cred),
      body: JSON.stringify(payload),
    };
  }

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

  function interpretGrabResponse(json) {
    if (json && json.successed) {
      const res = json.result || {};
      if (res.script) {
        return {
          success: true,
          orderId: res.apptUid,
          message: "下单成功，但返回微信支付参数，可能需要手动支付",
          requiresManualPayment: true,
          raw: json,
        };
      }
      return { success: true, orderId: res.apptUid, message: "抢订成功并已使用余额支付", raw: json };
    }
    return {
      success: false,
      message: (json && (json.message || JSON.stringify(json.messages) || `errorCode=${json.errorCode}`)) || "下单失败",
      raw: json,
    };
  }

  async function grab(target, cred) {
    const prebuilt = buildGrabRequest(target, cred);
    const { json } = await fireOnce(prebuilt);
    return interpretGrabResponse(json);
  }

  async function fireGrab(prebuilt) {
    const { json } = await fireOnce(prebuilt);
    return interpretGrabResponse(json);
  }

  async function listSlots(query, cred) {
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

  function classifyGrabResult(result) {
    if (result && result.success) return "success";
    const text = JSON.stringify(result || {}).toLowerCase();
    if (text.includes("操作太频繁") || text.includes("操作频繁") || text.includes("429")) return "rate-limited";
    if (text.includes("已被排课") || text.includes("排课") || text.includes("锁场")) return "terminal";
    if (text.includes("尚未放场") || text.includes("还没开场") || text.includes("未开放") || text.includes("超过可预约日期")) return "not-released";
    if (text.includes("timeout") || text.includes("aborted") || text.includes("econn") || text.includes("502") || text.includes("503")) return "transient";
    return "terminal";
  }

  function saveRetryCalibration(calibration) {
    if (!venueFile) return null;
    const fresh = yaml.load(fs.readFileSync(venueFile, "utf8"));
    fresh.releaseRetry = fresh.releaseRetry || {};
    fresh.releaseRetry.fastRetry = { ...(fresh.releaseRetry.fastRetry || {}), minIntervalMs: Number(calibration.extraWaitMs || 0), jitterMs: Number(fresh.releaseRetry.fastRetry?.jitterMs || 30), calibration: { ...calibration } };
    fs.writeFileSync(venueFile, yaml.dump(fresh, { lineWidth: -1, noRefs: true }), "utf8");
    cfg.releaseRetry = fresh.releaseRetry;
    meta.raw.releaseRetry = fresh.releaseRetry;
    return cfg.releaseRetry.fastRetry;
  }

  function discoverCapture(exchange) {
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

  async function riskProbe(cred) {
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

  return { meta, riskProfile, ready, grab, preheat, buildGrabRequest, fireGrab, prepareTarget, listSlots, interpretGrabResponse, classifyGrabResult, discoverCapture, riskProbe, saveRetryCalibration, listMyBookings, cancelBooking, loadTimeCards, pickTimeCard, payments: { wechat: B.payMethodWechat, balance: B.payMethodBalance, timecard: B.payMethodTimeCard != null ? B.payMethodTimeCard : null } };
}
