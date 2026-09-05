import crypto from "node:crypto";
import { request as undiciRequest } from "undici";
import QRCode from "qrcode";
import { db, nowIso } from "./database.js";
import { listVenues } from "./venueRegistry.js";
import { setCredential } from "./credentialStore.js";
import { doReadyCheck } from "./scheduler.js";

// Telegram Bot 模式: 无电脑用户用手机抓包 App(Quantumult X 等)导出 HAR 发给 bot, 服务端解析提取凭证。
// 绑定复用设备配对机制: bot 生成 court_capture_pair 二维码, 用户微信扫码后凭证归属该微信用户。
const API = "https://api.telegram.org";
const PAIR_TTL_MS = 10 * 60 * 1000;
let running = false;
let offset = 0;
const pendingPairs = new Map(); // chatId -> {deviceId, secret, expiresAt, timer}

async function tg(method, payload) {
  const { statusCode, body } = await undiciRequest(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await body.json();
  if (statusCode >= 400) throw new Error(`telegram ${method} ${statusCode}: ${JSON.stringify(json)}`);
  return json;
}

function chatIdOf(message) {
  return String(message?.chat?.id ?? "");
}

function linkedUser(chatId) {
  const row = db.prepare("SELECT * FROM telegram_links WHERE chat_id=?").get(chatId);
  if (!row) return null;
  const device = db.prepare("SELECT user_id, revoked FROM devices WHERE device_id=?").get(row.device_id);
  if (!device || device.revoked) return null;
  return { userId: row.user_id, deviceId: row.device_id };
}

async function sendMessage(chatId, text) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

function schedulePairCheck(chatId) {
  const entry = pendingPairs.get(chatId);
  if (!entry) return;
  const device = db.prepare("SELECT user_id FROM devices WHERE device_id=? AND revoked=0").get(entry.deviceId);
  if (device) {
    pendingPairs.delete(chatId);
    clearTimeout(entry.timer);
    db.prepare("INSERT OR REPLACE INTO telegram_links(chat_id, device_id, user_id, linked_at) VALUES(?,?,?,?)").run(chatId, entry.deviceId, device.user_id, nowIso());
    const profile = db.prepare("SELECT nickname FROM users WHERE id=?").get(device.user_id);
    sendMessage(chatId, `✅ 绑定成功：${profile?.nickname || "微信用户"}\n\n现在把抓包导出的 HAR 文件直接发给我即可保存球场凭证。`).catch(() => {});
    return;
  }
  if (Date.now() > entry.expiresAt) {
    pendingPairs.delete(chatId);
    clearTimeout(entry.timer);
    sendMessage(chatId, "⌛ 配对二维码已过期，请重新发送 /pair。").catch(() => {});
    return;
  }
  entry.timer = setTimeout(() => schedulePairCheck(chatId), 3000);
}

async function handlePairCommand(chatId) {
  if (linkedUser(chatId)) return sendMessage(chatId, "已绑定微信账号。发 HAR 文件即可保存凭证；/status 查看状态；/unbind 解绑。");
  if (pendingPairs.has(chatId)) return sendMessage(chatId, "已有未完成的配对，请先在微信里扫码。");
  const deviceId = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString("hex");
  const payload = { type: "court_capture_pair", deviceId, publicKey: secret, deviceName: "Telegram Bot" };
  const png = await QRCode.toBuffer(JSON.stringify(payload), { width: 480, margin: 2 });
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", "请用微信打开小程序，在「我的」页扫码配对（10 分钟内有效）。凭证将保存到你的账号。");
  form.append("photo", new Blob([png]), "pair.png");
  const { body } = await undiciRequest(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
  const json = await body.json();
  if (!json.ok) throw new Error("sendPhoto failed");
  pendingPairs.set(chatId, { deviceId, secret, expiresAt: Date.now() + PAIR_TTL_MS, timer: null });
  schedulePairCheck(chatId);
}

// 路径匹配与 CourtCapture capture.paths 语义一致: '*' 全匹配或尾通配
function pathMatches(pathname, patterns) {
  return patterns.some((pattern) => {
    const value = String(pattern);
    return value === "*" || pathname === value || (value.endsWith("*") && pathname.startsWith(value.slice(0, -1)));
  });
}

// 从 HAR 内存解析各已配置球场的凭证字段(不落盘), 多条命中取最新一条
export function extractCredentialsFromHar(har) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("HAR log.entries 无效");
  const hits = new Map(); // venueId -> {venueId, headers}
  for (const venue of listVenues()) {
    const capture = venue.raw?.capture;
    if (!capture?.enabled || !Array.isArray(capture.hosts) || !capture.hosts.length) continue;
    const wantedHosts = capture.hosts.map((host) => String(host).toLowerCase());
    for (const entry of entries) {
      const request = entry?.request;
      if (!request?.url) continue;
      let url;
      try { url = new URL(request.url); } catch { continue; }
      if (!wantedHosts.includes(url.hostname.toLowerCase())) continue;
      if (Array.isArray(capture.paths) && capture.paths.length && !pathMatches(url.pathname, capture.paths)) continue;
      const extracted = {};
      for (const name of capture.headers || []) {
        const header = (request.headers || []).find((item) => String(item.name).toLowerCase() === String(name).toLowerCase());
        if (header?.value) extracted[name] = String(header.value).trim();
      }
      if (Object.keys(extracted).length) hits.set(venue.id, { venueId: venue.id, name: venue.name, headers: extracted });
    }
  }
  return [...hits.values()];
}

async function downloadTelegramFile(fileId) {
  const info = await tg("getFile", { file_id: fileId });
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error("获取文件失败");
  const { body } = await undiciRequest(`${API}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  return Buffer.from(await body.arrayBuffer());
}

async function handleHarDocument(chatId, document) {
  const link = linkedUser(chatId);
  if (!link) return sendMessage(chatId, "尚未绑定微信账号，请先发送 /pair 生成配对二维码。");
  if (!/\.har$/i.test(String(document.file_name || ""))) return sendMessage(chatId, "请发送抓包导出的 .har 文件。");
  await tg("sendMessage", { chat_id: chatId, text: "正在解析 HAR…" });
  const buffer = await downloadTelegramFile(document.file_id);
  const har = JSON.parse(buffer.toString("utf-8"));
  const hits = extractCredentialsFromHar(har);
  if (!hits.length) {
    const configured = listVenues().filter((venue) => venue.raw?.capture?.enabled).map((venue) => `${venue.name}(${venue.raw.capture.hosts?.[0] || "?"})`).join("、") || "无";
    return sendMessage(chatId, `未在 HAR 中找到已配置球场的凭证请求。\n当前已配置监听的球场: ${configured}\n请确认抓包时使用过该球场的小程序。`);
  }
  const lines = [];
  for (const hit of hits) {
    // 按本场 credentialSchema 组装(与 ingest API 同规则), 缺字段跳过并提示
    const venue = listVenues().find((item) => item.id === hit.venueId);
    const schema = venue?.raw?.credentialSchema || [];
    const credential = {};
    for (const field of schema) {
      const value = hit.headers[field.key];
      if (value) credential[field.key] = value;
    }
    if (!Object.keys(credential).length || (schema.length && Object.keys(credential).length < schema.length)) {
      lines.push(`⚠️ ${hit.name}: 凭证字段不完整(${Object.keys(credential).length}/${schema.length}), 未保存`);
      continue;
    }
    setCredential(hit.venueId, credential, link.userId);
    let ready = null;
    try { ready = await doReadyCheck(hit.venueId, "telegram-ingest", link.userId); } catch {}
    lines.push(`${ready?.ok ? "✅" : "❌"} ${hit.name}: 凭证已保存${ready ? (ready.ok ? ", 校验通过" : `, 校验未通过(${ready.detail || "未知"})`) : ", 校验失败"}`);
  }
  return sendMessage(chatId, lines.join("\n"));
}

async function handleStatusCommand(chatId) {
  const link = linkedUser(chatId);
  if (!link) return sendMessage(chatId, "尚未绑定, 请发送 /pair。");
  const profile = db.prepare("SELECT nickname FROM users WHERE id=?").get(link.userId);
  const rows = db.prepare("SELECT venue_id, updated_at, ready_ok FROM credentials WHERE user_id=?").all(link.userId);
  const venueNames = new Map(listVenues().map((venue) => [venue.id, venue.name]));
  const credentialLines = rows.map((row) => `${row.ready_ok ? "✅" : "⚠️"} ${venueNames.get(row.venue_id) || row.venue_id} · ${row.updated_at.slice(0, 16).replace("T", " ")}`);
  return sendMessage(chatId, `绑定账号: ${profile?.nickname || "微信用户"}\n\n${credentialLines.length ? "凭证状态:\n" + credentialLines.join("\n") : "尚无已保存凭证"}`);
}

async function handleUnbindCommand(chatId) {
  db.prepare("DELETE FROM telegram_links WHERE chat_id=?").run(chatId);
  const entry = pendingPairs.get(chatId);
  if (entry) { clearTimeout(entry.timer); pendingPairs.delete(chatId); }
  return sendMessage(chatId, "已解除绑定。重新 /pair 可再次绑定。");
}

async function handleUpdate(update) {
  const message = update?.message;
  if (!message) return;
  const chatId = chatIdOf(message);
  if (!chatId) return;
  try {
    const text = String(message.text || "");
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await sendMessage(chatId, "球场凭证助手。\n\n/pair - 生成二维码, 微信扫码绑定账号\n(直接发送 HAR 文件) - 解析并保存凭证\n/status - 查看绑定与凭证状态\n/unbind - 解除绑定\n\n抓包方法: 手机抓包 App(Quantumult X / Reqable 等)抓取球场小程序流量后导出 HAR。");
    } else if (text.startsWith("/pair")) {
      await handlePairCommand(chatId);
    } else if (text.startsWith("/status")) {
      await handleStatusCommand(chatId);
    } else if (text.startsWith("/unbind")) {
      await handleUnbindCommand(chatId);
    } else if (message.document) {
      await handleHarDocument(chatId, message.document);
    }
  } catch (error) {
    console.warn("[telegram-bot]", String(error?.message || error));
    sendMessage(chatId, "处理失败: " + String(error?.message || error)).catch(() => {});
  }
}

export function startTelegramBot() {
  if (running || !process.env.TELEGRAM_BOT_TOKEN) return;
  running = true;
  console.log("[telegram-bot] started (long polling)");
  (async function loop() {
    while (running) {
      try {
        const { statusCode, body } = await undiciRequest(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["message"] }),
          bodyTimeout: 35000,
        });
        const json = await body.json();
        if (statusCode >= 400 || !json.ok) throw new Error(`getUpdates ${statusCode}`);
        for (const update of json.result || []) {
          offset = Math.max(offset, update.update_id + 1);
          await handleUpdate(update);
        }
      } catch (error) {
        if (String(error?.message || error).includes("bodyTimeout") === false) console.warn("[telegram-bot]", String(error?.message || error));
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  })();
}

export function stopTelegramBot() { running = false; }
