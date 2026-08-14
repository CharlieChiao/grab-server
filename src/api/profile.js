import express from "express";
import { db, nowIso } from "../core/database.js";

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
  };
}

router.get("/me", (req, res) => {
  const row = db.prepare("SELECT nickname,avatar_mime,avatar_data,profile_updated_at FROM users WHERE id=?").get(req.user.id);
  res.json(profileResponse(row));
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
  const row = db.prepare("SELECT nickname,avatar_mime,avatar_data,profile_updated_at FROM users WHERE id=?").get(req.user.id);
  res.json(profileResponse(row));
});

export default router;