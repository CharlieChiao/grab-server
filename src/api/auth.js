import express from "express";
import crypto from "node:crypto";
import { issueUserToken } from "../core/auth.js";
import { rememberOpenId } from "../core/notifications.js";

const router = express.Router();
const APPID = process.env.WECHAT_APPID || "wxe0cd72f1c259e016";
const APP_SECRET = process.env.WECHAT_APP_SECRET;

router.post("/wechat", async (req, res) => {
  const code = String(req.body?.code || "").trim();
  if (!code) return res.status(400).json({ error: "wx.login code is required" });
  if (!APP_SECRET) return res.status(503).json({ error: "server WeChat AppSecret is not configured" });
  try {
    const query = new URLSearchParams({ appid: APPID, secret: APP_SECRET, js_code: code, grant_type: "authorization_code" });
    const response = await fetch("https://api.weixin.qq.com/sns/jscode2session?" + query);
    const result = await response.json();
    if (!result.openid) return res.status(401).json({ error: "微信登录校验失败", detail: result.errmsg || result.errcode });
    const userId = crypto.createHash("sha256").update(String(result.openid)).digest("hex");
    rememberOpenId(userId, result.openid);
    res.json({ ok: true, token: issueUserToken(result.openid), expiresIn: 86400 });
  } catch (error) {
    res.status(502).json({ error: "微信登录服务不可用", detail: String(error.message || error) });
  }
});

export default router;
