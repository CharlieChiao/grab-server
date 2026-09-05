#!/usr/bin/env node
/**
 * Telegram 凭证助手 — 独立部署于可访问 Telegram API 的服务器(如 Orangechai)。
 * 通过 grab-server 的公开 API + 设备签名操作主服务, 不直接依赖主服务数据库。
 *
 * 用法: TELEGRAM_BOT_TOKEN=xxx GRAB_API_BASE=https://api.cn.orangechai.fun/grab node tools/telegram-bot.mjs
 * 依赖: npm install qrcode  (Node >= 18, 其余用内置 fetch/FormData/Blob)
 *
 * 命令: /pair(微信扫码绑定) /status /unbind /start /help; 直接发送 .har 文件提取凭证
 */
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import QRCode from "qrcode";

// systemd sd_notify 心跳: NOTIFY_SOCKET 存在时向 systemd 汇报 READY/WATCHDOG, 卡死超时会被强杀重启
function sdNotify(text) {
  const socketPath = process.env.NOTIFY_SOCKET;
  if (!socketPath) return;
  try {
    const client = dgram.createSocket("unix");
    const message = Buffer.from(text);
    const target = socketPath.startsWith("@") ? "\0" + socketPath.slice(1) : socketPath;
    client.on("error", () => { try { client.close(); } catch {} });
    client.send(message, 0, message.length, target, () => { try { client.close(); } catch {} });
  } catch {}
}

const API = "https://api.telegram.org";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GRAB_BASE = (process.env.GRAB_API_BASE || "https://api.cn.orangechai.fun/grab").replace(/\/+$/, "");
const PAIR_TTL_MS = 10 * 60 * 1000;
const DATA_FILE = process.env.BOT_DATA_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "telegram-bot.json");

// ---------- 本地状态: chat_id -> {deviceId, secret} ----------
let store = { chats: {} };
try { store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
function saveStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// ---------- 主服务 API(设备签名, 与 src/core/auth.js 验签逻辑一致) ----------
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function grabRequest(method, apiPath, device, body = {}) {
  const timestamp = String(Date.now());
  const bodyHash = crypto.createHash("sha256").update(canonicalJson(body)).digest("hex");
  const signature = crypto.createHmac("sha256", device.secret).update(`${timestamp}.${bodyHash}`).digest("hex");
  const response = await fetch(GRAB_BASE + apiPath, {
    method,
    headers: { "Content-Type": "application/json", "x-device-id": device.deviceId, "x-device-timestamp": timestamp, "x-device-signature": signature },
    body: method === "GET" ? JSON.stringify(body) : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { statusCode: response.status, json };
}

// ---------- Telegram API ----------
async function tg(method, payload) {
  const response = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}
async function sendMessage(chatId, text) {
  return tg("sendMessage", { chat_id: chatId, text });
}

// ---------- HAR 凭证提取(纯函数, 供测试复用) ----------
export function pathMatches(pathname, patterns) {
  return patterns.some((pattern) => {
    const value = String(pattern);
    return value === "*" || pathname === value || (value.endsWith("*") && pathname.startsWith(value.slice(0, -1)));
  });
}

export function extractCredentialsFromHar(har, venues) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("HAR log.entries 无效");
  const hits = new Map(); // venueId -> {venueId, name, headers}
  for (const venue of venues || []) {
    const capture = venue?.raw?.capture;
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

async function fetchVenues() {
  const response = await fetch(GRAB_BASE + "/api/venues");
  const json = await response.json();
  return json.venues || [];
}

// ---------- 命令处理 ----------
const pendingPairs = new Map(); // chatId -> {device, expiresAt, timer}

function schedulePairCheck(chatId) {
  const entry = pendingPairs.get(chatId);
  if (!entry) return;
  (async () => {
    try {
      const { statusCode, json } = await grabRequest("GET", "/api/devices/me", entry.device);
      if (statusCode === 200 && json.paired) {
        pendingPairs.delete(chatId);
        clearTimeout(entry.timer);
        store.chats[chatId] = entry.device;
        saveStore();
        await sendMessage(chatId, `✅ 绑定成功：${json.user?.nickname || "微信用户"}\n\n现在把抓包导出的 HAR 文件直接发给我即可保存球场凭证。`);
        return;
      }
    } catch (error) { console.warn("[pair-check]", String(error?.message || error)); }
    if (Date.now() > entry.expiresAt) {
      pendingPairs.delete(chatId);
      clearTimeout(entry.timer);
      await sendMessage(chatId, "⌛ 配对二维码已过期，请重新发送 /pair。").catch(() => {});
      return;
    }
    entry.timer = setTimeout(() => schedulePairCheck(chatId), 3000);
  })();
}

async function handlePairCommand(chatId) {
  if (store.chats[chatId]) return sendMessage(chatId, "已绑定微信账号。发 HAR 文件即可保存凭证；/status 查看状态；/unbind 解绑。");
  if (pendingPairs.has(chatId)) return sendMessage(chatId, "已有未完成的配对，请先在微信里扫码。");
  const device = { deviceId: crypto.randomUUID(), secret: crypto.randomBytes(32).toString("hex") };
  const payload = { type: "court_capture_pair", deviceId: device.deviceId, publicKey: device.secret, deviceName: "Telegram Bot" };
  const png = await QRCode.toBuffer(JSON.stringify(payload), { width: 480, margin: 2 });
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", "请用微信打开小程序，在「我的」页扫码配对（10 分钟内有效）。凭证将保存到你的账号。");
  form.append("photo", new Blob([png]), "pair.png");
  const response = await fetch(`${API}/bot${TOKEN}/sendPhoto`, { method: "POST", body: form });
  const json = await response.json();
  if (!json.ok) throw new Error("sendPhoto failed");
  pendingPairs.set(chatId, { device, expiresAt: Date.now() + PAIR_TTL_MS, timer: null });
  schedulePairCheck(chatId);
}

async function downloadTelegramFile(fileId) {
  const info = await tg("getFile", { file_id: fileId });
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error("获取文件失败");
  const response = await fetch(`${API}/file/bot${TOKEN}/${filePath}`);
  return Buffer.from(await response.arrayBuffer());
}

async function handleHarDocument(chatId, document) {
  const device = store.chats[chatId];
  if (!device) return sendMessage(chatId, "尚未绑定微信账号，请先发送 /pair 生成配对二维码。");
  if (!/\.har$/i.test(String(document.file_name || ""))) return sendMessage(chatId, "请发送抓包导出的 .har 文件。");
  await sendMessage(chatId, "正在解析 HAR…");
  const buffer = await downloadTelegramFile(document.file_id);
  const har = JSON.parse(buffer.toString("utf-8"));
  const venues = await fetchVenues();
  const hits = extractCredentialsFromHar(har, venues);
  if (!hits.length) {
    const configured = venues.filter((venue) => venue?.raw?.capture?.enabled).map((venue) => venue.name).join("、") || "无";
    return sendMessage(chatId, `未在 HAR 中找到已配置球场的凭证请求。\n当前已配置监听的球场: ${configured}\n请确认抓包时使用过该球场的小程序。`);
  }
  const lines = [];
  for (const hit of hits) {
    const { statusCode, json } = await grabRequest("POST", `/api/credentials/${hit.venueId}/ingest`, device, { headers: hit.headers });
    if (statusCode >= 400) {
      lines.push(`❌ ${hit.name}: ${json.error || `保存失败(${statusCode})`}`);
      continue;
    }
    lines.push(`${json.ready ? "✅" : "⚠️"} ${hit.name}: 凭证已保存${json.ready === null || json.ready === undefined ? "" : json.ready ? ", 校验通过" : ", 校验未通过(凭证可能失效)"}`);
  }
  return sendMessage(chatId, lines.join("\n"));
}

async function handleStatusCommand(chatId) {
  const device = store.chats[chatId];
  if (!device) return sendMessage(chatId, "尚未绑定, 请发送 /pair。");
  const { statusCode, json } = await grabRequest("GET", "/api/devices/me", device);
  if (statusCode !== 200) return sendMessage(chatId, "绑定已失效，请重新 /pair。");
  const venues = await fetchVenues();
  const lines = [`绑定账号: ${json.user?.nickname || "微信用户"}`];
  for (const venue of venues.filter((item) => item?.raw?.capture?.enabled)) {
    const check = await grabRequest("GET", `/api/ready/${venue.id}/cache`, device);
    const result = check.json?.cached?.result;
    lines.push(`${result?.ok ? "✅" : "⚠️"} ${venue.name}${result ? (result.ok ? "" : ` (${result.detail || "未通过"})`) : " (尚无凭证)"}`);
  }
  return sendMessage(chatId, lines.join("\n"));
}

async function handleUnbindCommand(chatId) {
  delete store.chats[chatId];
  saveStore();
  return sendMessage(chatId, "已解除绑定。重新 /pair 可再次绑定。");
}

async function handleUpdate(update) {
  const message = update?.message;
  if (!message) return;
  const chatId = String(message.chat?.id ?? "");
  if (!chatId) return;
  try {
    const text = String(message.text || "");
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await sendMessage(chatId, "球场凭证助手。\n\n/pair - 生成二维码, 微信扫码绑定账号\n(直接发送 HAR 文件) - 解析并保存凭证\n/status - 查看绑定与凭证状态\n/unbind - 解除绑定\n\n抓包方法: 手机抓包 App(Quantumult X / Reqable 等)抓取球场小程序流量后导出 HAR。");
    } else if (text.startsWith("/pair")) await handlePairCommand(chatId);
    else if (text.startsWith("/status")) await handleStatusCommand(chatId);
    else if (text.startsWith("/unbind")) await handleUnbindCommand(chatId);
    else if (message.document) await handleHarDocument(chatId, message.document);
  } catch (error) {
    console.warn("[bot]", String(error?.message || error));
    sendMessage(chatId, "处理失败: " + String(error?.message || error)).catch(() => {});
  }
}

// ---------- 入口: 仅作为主模块运行时启动长轮询 ----------
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  if (!TOKEN) { console.error("缺少 TELEGRAM_BOT_TOKEN"); process.exit(1); }
  let offset = 0;
  console.log(`[telegram-bot] started, grab api: ${GRAB_BASE}`);
  sdNotify("READY=1");
  while (true) {
    sdNotify("WATCHDOG=1"); // 每轮长轮询(约25s)心跳一次, 超时未心跳则被 systemd 强杀重启
    try {
      const response = await fetch(`${API}/bot${TOKEN}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["message"] }),
        signal: AbortSignal.timeout(35000), // fetch 无默认超时, 显式兜底防止事件循环挂起
      });
      const json = await response.json();
      if (!json.ok) throw new Error(`getUpdates: ${response.status}`);
      for (const update of json.result || []) {
        offset = Math.max(offset, update.update_id + 1);
        await handleUpdate(update);
      }
    } catch (error) {
      console.warn("[telegram-bot]", String(error?.message || error));
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
