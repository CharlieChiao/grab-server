import express from "express";
import { db, nowIso } from "../core/database.js";
import { encryptOpenId, decryptOpenId } from "../core/notifications.js";

const router = express.Router();
const MAX_AVATAR_BYTES = 512 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function profileResponse(row) {
  return {
    ok: true,
    nickname: row?.nickname || "微信用户",
    avatar: row?.avatar_data
      ? `data:${row.avatar_mime || "image/jpeg"};base64,${Buffer.from(row.avatar_data).toString("base64")}`
      : "",
    updatedAt: row?.profile_updated_at || null,
    developer: !!row?.developer,
    barkConfigured: !!row?.bark_key,
  };
}

router.get("/me", (req, res) => {
  const row = db.prepare("SELECT nickname,avatar_mime,avatar_data,profile_updated_at,developer,bark_key FROM users WHERE id=?").get(req.user.id);
  res.json(profileResponse(row));
});

// 定场人头像(image 标签可直连, 免认证; userId 为不可猜测哈希)。v 参数为头像版本号用于缓存更新
router.get("/users/:userId/avatar", (req, res) => {
  const row = db.prepare("SELECT avatar_mime, avatar_data, profile_updated_at FROM users WHERE id=?").get(String(req.params.userId || ""));
  if (!row?.avatar_data) return res.status(404).end();
  res.setHeader("Content-Type", row.avatar_mime || "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  if (req.query.v) res.setHeader("ETag", `"${req.query.v}"`);
  res.end(Buffer.from(row.avatar_data));
});

router.put("/me", (req, res) => {
  const nickname = String(req.body?.nickname || "").trim().slice(0, 40);
  const mime = String(req.body?.avatarMime || "image/jpeg").toLowerCase();
  const avatarBase64 = String(req.body?.avatarBase64 || "").replace(/^data:[^;]+;base64,/, "");
  if (!nickname) return res.status(400).json({ error: "昵称不能为空" });
  if (!ALLOWED_MIME.has(mime)) return res.status(400).json({ error: "不支持的头像格式" });
  let avatar = null;
  if (avatarBase64) {
    try { avatar = Buffer.from(avatarBase64, "base64"); } catch { return res.status(400).json({ error: "头像数据无效" }); }
    if (!avatar.length || avatar.length > MAX_AVATAR_BYTES) return res.status(400).json({ error: "头像大小必须小于 512KB" });
  }
  const now = nowIso();
  db.prepare(`UPDATE users SET nickname=?, avatar_mime=COALESCE(?,avatar_mime), avatar_data=COALESCE(?,avatar_data), profile_updated_at=? WHERE id=?`)
    .run(nickname, avatar ? mime : null, avatar, now, req.user.id);
  const row = db.prepare("SELECT nickname,avatar_mime,avatar_data,profile_updated_at,developer FROM users WHERE id=?").get(req.user.id);
  res.json(profileResponse(row));
});

// Bark 输入解析: 支持纯 key / 完整 URL / curl 命令(Bark App"复制"出来的是含 URL 的整段文本, 直接粘贴即可)
// 返回 { key, server } — server 仅在自建服务器 URL 时返回, 官方 api.day.app 返回 null
export function extractBarkInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  // 任意文本中找第一个 bark 风格 URL: https://host/key (key 为 20-64 位字母数字)
  const m = s.match(/https?:\/\/([^/\s"'`]+)\/([A-Za-z0-9_-]{20,64})(?:[/?\s"'`]|$)/);
  if (m) {
    const server = /^api\.day\.app$/.test(m[1]) ? null : `https://${m[1]}`;
    return { key: m[2], server };
  }
  // 纯 key
  if (/^[A-Za-z0-9_-]{20,64}$/.test(s)) return { key: s, server: null };
  return null;
}

// Bark 推送配置(iOS): 输入可为纯 key/URL/curl 命令, 服务器自动解析提取; 置空清除
router.put("/me/bark-key", (req, res) => {
  const raw = String(req.body?.barkKey || "").trim();
  if (!raw) {
    db.prepare("UPDATE users SET bark_key=NULL,bark_server=NULL WHERE id=?").run(req.user.id);
    const row = db.prepare("SELECT nickname,avatar_mime,avatar_data,profile_updated_at,developer,bark_key FROM users WHERE id=?").get(req.user.id);
    return res.json(profileResponse(row));
  }
  const parsed = extractBarkInput(raw);
  if (!parsed) return res.status(400).json({ error: "未识别出 Bark Key——请直接粘贴 Bark App 首页\"复制\"的完整链接(形如 https://api.day.app/xxxx)" });
  db.prepare("UPDATE users SET bark_key=?,bark_server=? WHERE id=?").run(encryptOpenId(parsed.key), parsed.server, req.user.id);
  const row = db.prepare("SELECT nickname,avatar_mime,avatar_data,profile_updated_at,developer,bark_key FROM users WHERE id=?").get(req.user.id);
  res.json(profileResponse(row));
});

// Bark 测试推送(验证绑定有效性)
router.post("/me/bark-test", async (req, res) => {
  const row = db.prepare("SELECT bark_key,bark_server FROM users WHERE id=?").get(req.user.id);
  if (!row?.bark_key) return res.status(400).json({ error: "尚未配置 Bark Key" });
  try {
    const key = decryptOpenId(row.bark_key);
    const server = row.bark_server || process.env.BARK_SERVER || "https://api.day.app";
    const push = await fetch(`${server}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_key: key, title: "抢订通知测试", body: "Bark 绑定成功！任务结果将实时推送到这台 iPhone。", group: "测试" }),
    });
    const json = await push.json().catch(() => null);
    if (json?.code === 200) return res.json({ ok: true });
    return res.status(502).json({ error: json?.message || "推送失败, 请检查 Key" });
  } catch (error) { res.status(502).json({ error: "推送请求失败: " + String(error?.message || error) }); }
});

export default router;