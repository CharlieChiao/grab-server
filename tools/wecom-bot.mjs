#!/usr/bin/env node
/**
 * 球场凭证助手网页版 — 部署于 https://orangechai.fun/grab-service/ (nginx 反代本机 3101)
 * 功能: 网页生成配对二维码(小程序扫码) / 上传 HAR 解析并保存凭证 / 状态 / 解绑
 * 复用 telegram-bot 的 HAR 提取与设备签名逻辑; 企微机器人相关(webhook 推送/流云中转)保留但默认停用
 *
 * 用法: node tools/wecom-bot.mjs (配置见 .wecom-bot.env)
 * 依赖: npm install qrcode (Node >= 18)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { extractCredentialsFromHar } from "./telegram-bot.mjs";

const WEBHOOK_KEY = process.env.WECOM_WEBHOOK_KEY;
const RELAY_TOKEN = process.env.WECOM_RELAY_TOKEN || "";
const RELAY_PATH = process.env.WECOM_RELAY_PATH || "/relay/wecom";
const CALLBACK_TOKEN = process.env.WECOM_CALLBACK_TOKEN || "";
const CALLBACK_AES_KEY = process.env.WECOM_ENCODING_AES_KEY ? Buffer.from(process.env.WECOM_ENCODING_AES_KEY + "=", "base64") : null;
const CALLBACK_PATH = process.env.WECOM_CALLBACK_PATH || "/callback/wecom";
const GRAB_BASE = (process.env.GRAB_API_BASE || "https://api.cn.orangechai.fun/grab").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 3101);
const ACCESS_TOKEN = process.env.BOT_ACCESS_TOKEN || "";
const PAIR_TTL_MS = 10 * 60 * 1000;
const DATA_FILE = process.env.BOT_DATA_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "wecom-bot.json");

// ---------- 本地状态: 企微 userid -> {deviceId, secret}, secret 用于生成用户上传链接令牌 ----------
let store = { secret: null, users: {}, names: {} };
try { store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
store.users = store.users || {};
store.names = store.names || {}; // userid -> 企微显示名, 仅用于群消息展示
if (store.device && !store.users.default) store.users.default = store.device; // 兼容旧版群级绑定
delete store.device;
const displayName = (user) => store.names[user] || user;
if (!store.secret) { store.secret = crypto.randomBytes(32).toString("hex"); saveStoreLater(); }
function saveStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}
function saveStoreLater() { try { saveStore(); } catch {} }
const userToken = (userid) => crypto.createHmac("sha256", store.secret).update(String(userid)).digest("hex").slice(0, 32);
function resolveUser(req, url) {
  const u = String(req.headers["x-wecom-user"] || url.searchParams.get("u") || "");
  const t = String(req.headers["x-wecom-user-token"] || url.searchParams.get("t") || "");
  if (u && t && t === userToken(u)) return u;
  return "default";
}

// ---------- 主服务 API(设备签名, 与 telegram-bot.mjs 保持一致) ----------
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function grabRequest(method, apiPath, device, body = {}) {
  const timestamp = String(Date.now());
  const signBody = method === "GET" ? {} : body; // GET 无 body, 签名按空对象计
  const bodyHash = crypto.createHash("sha256").update(canonicalJson(signBody)).digest("hex");
  const signature = crypto.createHmac("sha256", device.secret).update(`${timestamp}.${bodyHash}`).digest("hex");
  const response = await fetch(GRAB_BASE + apiPath, {
    method,
    headers: { "Content-Type": "application/json", "x-device-id": device.deviceId, "x-device-timestamp": timestamp, "x-device-signature": signature },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { statusCode: response.status, json };
}
async function fetchVenues() {
  const response = await fetch(GRAB_BASE + "/api/venues");
  const json = await response.json();
  return json.venues || [];
}

// ---------- 企微群机器人 webhook 推送 ----------
async function wecomSend(payload) {
  if (!WEBHOOK_KEY) return; // 未配置 webhook 时跳过推送, 纯网页模式
  const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${WEBHOOK_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await response.json().catch(() => ({}));
  if (json.errcode) throw new Error(`wecom webhook: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}
const wecomText = (content) => wecomSend({ msgtype: "markdown", markdown: { content } });
async function wecomImage(png) {
  return wecomSend({ msgtype: "image", image: { base64: png.toString("base64"), md5: crypto.createHash("md5").update(png).digest("hex") } });
}

// ---------- 企微回调验签/解密(token + AES-256-CBC) ----------
function wecomSignature(token, timestamp, nonce, encrypt) {
  return crypto.createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
}
function wecomDecrypt(encryptBase64) {
  const decipher = crypto.createDecipheriv("aes-256-cbc", CALLBACK_AES_KEY, CALLBACK_AES_KEY.subarray(0, 16));
  decipher.setAutoPadding(false); // 企微用 32 字节块的 PKCS7, 需手动去 padding
  let buf = Buffer.concat([decipher.update(encryptBase64, "base64"), decipher.final()]);
  buf = buf.subarray(0, buf.length - buf[buf.length - 1]);
  const msgLen = buf.readUInt32BE(16); // 明文结构: 16 字节随机 + 4 字节长度 + 消息 + receiveid
  return buf.subarray(20, 20 + msgLen).toString("utf8");
}
function xmlField(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`)) || String(xml).match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : "";
}

// ---------- 用户绑定(按企微 userid) ----------
const pendingPairs = new Map(); // userid -> { device, expiresAt, uploadUrl }

function schedulePairCheck(user) {
  setTimeout(async () => {
    const entry = pendingPairs.get(user);
    if (!entry) return; // 已解绑/已完成
    try {
      const { statusCode, json } = await grabRequest("GET", "/api/devices/me", entry.device);
      if (statusCode === 200 && json.paired) {
        pendingPairs.delete(user);
        store.users[user] = entry.device;
        saveStore();
        await wecomText(`**✅ ${displayName(user)} 绑定成功**：${json.user?.nickname || "微信用户"}\n[点此上传 HAR 文件](${entry.uploadUrl})`);
        return;
      }
    } catch (error) { console.warn("[pair-check]", String(error?.message || error)); }
    if (Date.now() > entry.expiresAt) {
      pendingPairs.delete(user);
      await wecomText(`⌛ ${displayName(user)} 的配对二维码已过期, 请重新发送「绑定」`).catch(() => {});
      return;
    }
    schedulePairCheck(user);
  }, 3000);
}

function publicBase(req) {
  if (process.env.WECOM_PUBLIC_BASE) return process.env.WECOM_PUBLIC_BASE.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).split(",")[0].trim();
  return `${proto}://${host}`;
}

async function handlePair(req, user) {
  if (store.users[user]) throw new Error(`${user} 已绑定, 如需换绑请先发送「解绑」`);
  if (pendingPairs.has(user)) throw new Error("已有未完成的配对, 请先在小程序里扫码");
  const uploadUrl = `${publicBase(req)}/?u=${encodeURIComponent(user)}&t=${userToken(user)}`;
  const device = { deviceId: crypto.randomUUID(), secret: crypto.randomBytes(32).toString("hex") };
  const payload = { type: "court_capture_pair", deviceId: device.deviceId, publicKey: device.secret, deviceName: "WeCom Bot" };
  const png = await QRCode.toBuffer(JSON.stringify(payload), { width: 480, margin: 2 });
  await wecomImage(png);
  await wecomText(`**${displayName(user)} 请用微信打开小程序, 在「我的」页扫码配对(10 分钟内有效)**\n[点此打开 HAR 上传页](${uploadUrl})`);
  pendingPairs.set(user, { device, expiresAt: Date.now() + PAIR_TTL_MS, uploadUrl });
  schedulePairCheck(user);
  return { qr: `data:image/png;base64,${png.toString("base64")}`, uploadUrl, expiresAt: Date.now() + PAIR_TTL_MS };
}

// ---------- HAR 解析(复用 telegram-bot 的纯函数) ----------
async function handleUpload(har, user) {
  const device = store.users[user];
  if (!device) throw new Error("当前身份未绑定, 请先在群里 @机器人 发送「绑定」");
  const venues = await fetchVenues();
  const hits = extractCredentialsFromHar(har, venues);
  if (!hits.length) {
    const configured = venues.filter((venue) => venue?.raw?.capture?.enabled).map((venue) => venue.name).join("、") || "无";
    return { lines: [`未在 HAR 中找到已配置球场的凭证请求。\n当前已配置监听的球场: ${configured}\n请确认抓包时使用过该球场的小程序。`] };
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
  return { lines };
}

async function handleStatus(user) {
  const device = store.users[user];
  if (!device) throw new Error("尚未绑定, 请发送「绑定」");
  const { statusCode, json } = await grabRequest("GET", "/api/devices/me", device);
  if (statusCode !== 200) throw new Error("绑定已失效, 请重新发送「绑定」");
  const venues = await fetchVenues();
  const lines = [`绑定账号: ${json.user?.nickname || "微信用户"}`];
  for (const venue of venues.filter((item) => item?.raw?.capture?.enabled)) {
    const check = await grabRequest("GET", `/api/ready/${venue.id}/cache`, device);
    const result = check.json?.cached?.result;
    lines.push(`${result?.ok ? "✅" : "⚠️"} ${venue.name}${result ? (result.ok ? "" : ` (${result.detail || "未通过"})`) : " (尚无凭证)"}`);
  }
  return { lines };
}

async function handleUnbind(user) {
  pendingPairs.delete(user);
  delete store.users[user];
  saveStore();
  return { ok: true };
}

// ---------- 群内 @机器人 文本命令 ----------
const HELP_TEXT = `**球场凭证助手**
在群里 @我 并发送:
**绑定** - 生成小程序配对二维码
**状态** - 查看绑定与凭证状态
**解绑** - 解除当前账号绑定
**HAR 上传** - 绑定后点击机器人推送的链接, 在网页上传抓包导出的 .har 文件(回调不支持文件, 只能走网页)`;

async function handleChatCommand(req, user, content) {
  const text = String(content || "").replace(/^@\S+\s*/, "").trim(); // 去掉 @机器人 前缀
  if (/^(绑定|pair|bind)/i.test(text)) {
    await handlePair(req, user);
  } else if (/^(状态|status)/i.test(text)) {
    const { lines } = await handleStatus(user);
    await wecomText(`**📋 ${displayName(user)} 的凭证状态**\n` + lines.join("\n"));
  } else if (/^(解绑|unbind)/i.test(text)) {
    await handleUnbind(user);
    await wecomText(`已解除 ${displayName(user)} 的绑定。`);
  } else {
    await wecomText(HELP_TEXT);
  }
}

// 企微会对未及时应答的回调重试, 用 MsgId 去重
const recentMsgIds = new Map();
function isDuplicate(msgId) {
  if (!msgId) return false;
  if (recentMsgIds.has(msgId)) return true;
  recentMsgIds.set(msgId, Date.now());
  if (recentMsgIds.size > 200) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, ts] of recentMsgIds) if (ts < cutoff) recentMsgIds.delete(id);
  }
  return false;
}

// ---------- HTTP 服务: 回调 + 操作页面 + JSON API ----------
function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) { reject(new Error("文件过大(上限 64MB)")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const reply = (code, data) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); };
  try {
    // ---------- 企微回调: URL 验证(GET) + 消息推送(POST) ----------
    if (url.pathname === CALLBACK_PATH) {
      if (!CALLBACK_TOKEN || !CALLBACK_AES_KEY) { res.writeHead(500); return res.end("callback not configured"); }
      const msgSignature = String(url.searchParams.get("msg_signature") || "");
      const timestamp = String(url.searchParams.get("timestamp") || "");
      const nonce = String(url.searchParams.get("nonce") || "");
      if (req.method === "GET") {
        const echostr = String(url.searchParams.get("echostr") || "");
        if (wecomSignature(CALLBACK_TOKEN, timestamp, nonce, echostr) !== msgSignature) { res.writeHead(403); return res.end(""); }
        return res.end(wecomDecrypt(echostr)); // 必须返回解密后的明文 echo
      }
      if (req.method === "POST") {
        const body = (await readBody(req, 1024 * 1024)).toString("utf-8");
        const encrypt = xmlField(body, "Encrypt");
        if (!encrypt || wecomSignature(CALLBACK_TOKEN, timestamp, nonce, encrypt) !== msgSignature) { res.writeHead(403); return res.end(""); }
        const xml = wecomDecrypt(encrypt);
        res.end(""); // 先应答避免企微重试, 再异步处理
        if (xmlField(xml, "MsgType") !== "text") return;
        const msgId = xmlField(xml, "MsgId");
        if (isDuplicate(msgId)) return;
        const user = xmlField(xml, "FromUserName") || "default";
        const content = xmlField(xml, "Content");
        handleChatCommand(req, user, content).catch((error) => {
          console.warn("[callback]", String(error?.message || error));
          wecomText(`❌ 处理失败: ${String(error?.message || error).slice(0, 200)}`).catch(() => {});
        });
        return;
      }
      res.writeHead(405); return res.end("");
    }

    // ---------- 流云中转: 工作流 Python 节点把 at 机器人的消息转发到这里 ----------
    if (req.method === "POST" && url.pathname === RELAY_PATH) {
      if (!RELAY_TOKEN || req.headers["x-relay-token"] !== RELAY_TOKEN) { res.writeHead(403); return res.end(""); }
      let msg;
      try { msg = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf-8")); } catch { return reply(400, { error: "bad json" }); }
      reply(200, { ok: true }); // 立即应答避免工作流节点超时, 异步处理
      const msgId = String(msg.msgId || "");
      if (msgId && isDuplicate(msgId)) return;
      if (String(msg.msgType || "text") !== "text") return; // 目前仅支持文本命令
      const user = String(msg.userId || "default");
      const name = String(msg.name || "");
      if (user !== "default" && name && store.names[user] !== name) { store.names[user] = name; saveStore(); }
      const content = String(msg.contentWithoutMention || msg.content || "").replace(/^@\S+\s*/, "").trim();
      handleChatCommand(req, user, content).catch((error) => {
        console.warn("[relay]", String(error?.message || error));
        wecomText(`❌ 处理失败: ${String(error?.message || error).slice(0, 200)}`).catch(() => {});
      });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE_HTML);
    }
    if (ACCESS_TOKEN && url.pathname.startsWith("/api/")) {
      const token = req.headers["x-bot-token"] || url.searchParams.get("token") || "";
      if (token !== ACCESS_TOKEN) return reply(401, { error: "访问口令无效" });
    }
    const user = resolveUser(req, url);

    if (req.method === "GET" && url.pathname === "/api/state") {
      let bound = false, nickname = null;
      if (store.users[user]) {
        try {
          const { statusCode, json } = await grabRequest("GET", "/api/devices/me", store.users[user]);
          if (statusCode === 200 && json.paired) { bound = true; nickname = json.user?.nickname || null; }
        } catch {}
      }
      return reply(200, { bound, user, nickname, pending: pendingPairs.has(user) });
    }
    if (req.method === "POST" && url.pathname === "/api/pair") return reply(200, await handlePair(req, user));
    if (req.method === "POST" && url.pathname === "/api/status") {
      const { lines } = await handleStatus(user);
      wecomText(`**📋 ${displayName(user)} 的凭证状态**\n` + lines.join("\n")).catch(() => {});
      return reply(200, { ok: true, lines });
    }
    if (req.method === "POST" && url.pathname === "/api/unbind") {
      await handleUnbind(user);
      wecomText(`已解除 ${user} 的绑定。`).catch(() => {});
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/upload") {
      const body = await readBody(req);
      let har;
      try { har = JSON.parse(body.toString("utf-8")); } catch { return reply(400, { error: "HAR 文件解析失败, 请确认导出的是 .har 格式" }); }
      const name = url.searchParams.get("name") || "upload.har";
      const { lines } = await handleUpload(har, user);
      wecomText(`📄 ${displayName(user)} 上传了 HAR 文件 \`${name}\`\n` + lines.join("\n")).catch(() => {});
      return reply(200, { ok: true, lines });
    }
    reply(404, { error: "not found" });
  } catch (error) {
    console.warn("[wecom-bot]", String(error?.message || error));
    reply(400, { error: String(error?.message || error) });
  }
});

// @todo 若企微要求 HTTPS 回调, 需 nginx 前置并保留 x-forwarded-proto 头
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>球场凭证助手</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; margin: 0; color: #1f2329; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0; }
  .card { background: #fff; border-radius: 12px; padding: 20px; margin-top: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
  .muted { color: #86909c; font-size: 13px; margin-top: 6px; }
  button { border: 0; border-radius: 8px; padding: 10px 16px; font-size: 14px; cursor: pointer; background: #07c160; color: #fff; }
  button.ghost { background: #f2f3f5; color: #1f2329; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  #qr { max-width: 260px; width: 100%; display: none; margin: 16px auto 0; }
  pre { background: #f7f8fa; border-radius: 8px; padding: 12px; white-space: pre-wrap; word-break: break-all; font-size: 13px; margin: 12px 0 0; display: none; font-family: inherit; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  input[type=file] { font-size: 13px; max-width: 220px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: #fa5151; }
  .dot.ok { background: #07c160; }
</style>
</head>
<body>
<div class="wrap">
  <h1>球场凭证助手</h1>
  <div class="muted">球场抓包凭证上传与账号绑定工具</div>

  <div class="card">
    <div class="row" style="justify-content: space-between">
      <div><span class="dot" id="dot"></span><span id="bindState">检查中…</span></div>
      <div class="row">
        <button id="btnPair">配对绑定</button>
        <button id="btnStatus" class="ghost">凭证状态</button>
        <button id="btnUnbind" class="ghost">解绑</button>
      </div>
    </div>
    <img id="qr" alt="配对二维码">
    <pre id="out"></pre>
  </div>

  <div class="card">
    <div class="row">
      <input type="file" id="file" accept=".har,application/json">
      <button id="btnUpload" disabled>解析并保存</button>
    </div>
    <div class="muted">上传抓包导出的 .har 文件, 自动提取球场凭证并保存到已绑定账号</div>
    <pre id="upOut"></pre>
  </div>
</div>
<script>
  var qs = new URLSearchParams(location.search);
  var TOKEN = qs.get('token') || '', U = qs.get('u') || '', UT = qs.get('t') || '';
  var qr = document.getElementById('qr'), out = document.getElementById('out'), upOut = document.getElementById('upOut');
  var dot = document.getElementById('dot'), bindState = document.getElementById('bindState');
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'x-bot-token': TOKEN, 'x-wecom-user': U, 'x-wecom-user-token': UT }, opts.headers || {});
    return fetch(path, opts).then(function (r) { // path 用相对路径, 兼容 nginx 子路径部署
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    });
  }
  function show(el, text) { el.textContent = text; el.style.display = 'block'; }
  var stateTimer = null;
  function refreshState() {
    api('api/state').then(function (s) {
      dot.className = 'dot' + (s.bound ? ' ok' : '');
      bindState.textContent = (s.bound ? '已绑定: ' + (s.nickname || '微信用户') : '未绑定') + (s.user && s.user !== 'default' ? ' (' + s.user + ')' : '');
      if (s.bound) { qr.style.display = 'none'; if (stateTimer) { clearInterval(stateTimer); stateTimer = null; } }
    }).catch(function (e) { bindState.textContent = '状态获取失败: ' + e.message; });
  }
  refreshState();
  setInterval(refreshState, 5000);

  document.getElementById('btnPair').onclick = function () {
    api('api/pair', { method: 'POST' }).then(function (j) {
      qr.src = j.qr; qr.style.display = 'block';
      show(out, '请用微信打开小程序, 在「我的」页扫码配对(10 分钟内有效)。');
      if (!stateTimer) stateTimer = setInterval(refreshState, 3000);
    }).catch(function (e) { show(out, e.message); });
  };
  document.getElementById('btnStatus').onclick = function () {
    show(out, '查询中…');
    api('api/status', { method: 'POST' }).then(function (j) { show(out, j.lines.join('\\n')); }).catch(function (e) { show(out, e.message); });
  };
  document.getElementById('btnUnbind').onclick = function () {
    api('api/unbind', { method: 'POST' }).then(function () { refreshState(); show(out, '已解除绑定'); }).catch(function (e) { show(out, e.message); });
  };

  var file = document.getElementById('file'), btnUpload = document.getElementById('btnUpload');
  file.onchange = function () { btnUpload.disabled = !file.files.length; };
  btnUpload.onclick = function () {
    var f = file.files[0];
    if (!f) return;
    btnUpload.disabled = true; btnUpload.textContent = '解析中…';
    f.text().then(function (text) {
      return api('api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
    }).then(function (j) {
      show(upOut, j.lines.join('\\n'));
    }).catch(function (e) {
      show(upOut, e.message);
    }).finally(function () {
      btnUpload.textContent = '解析并保存'; file.value = ''; btnUpload.disabled = true;
    });
  };
</script>
</body>
</html>`;

if (!WEBHOOK_KEY) console.warn("未配置 WECOM_WEBHOOK_KEY, 纯网页模式运行(不推送到企微群)");
if (!RELAY_TOKEN) console.warn("未配置 WECOM_RELAY_TOKEN, 流云转发的消息将被拒绝(/relay/wecom 403)");
server.listen(PORT, () => {
  console.log(`[wecom-bot] started, page: http://localhost:${PORT}/, callback: ${CALLBACK_PATH}, grab api: ${GRAB_BASE}`);
});
