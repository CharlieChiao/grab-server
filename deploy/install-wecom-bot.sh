#!/usr/bin/env bash
# ==============================================================================
# 一键部署球场凭证助手网页版 (grab-wecom-bot, https://orangechai.fun/grab-service/)
# 前置: tools/wecom-bot.mjs / .wecom-bot.env / config/grab-wecom-bot.service 已上传
# 作用: 安装 systemd 服务 + 主站 nginx 配置 /grab-service/ 反代(并清理旧 /wecom-bot/)
# 用法: ssh 到服务器后执行  bash deploy/install-wecom-bot.sh
# ==============================================================================
set -euo pipefail

PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------- systemd 服务 ----------
cp "$PROJ_DIR/config/grab-wecom-bot.service" /etc/systemd/system/grab-wecom-bot.service
systemctl daemon-reload
systemctl enable grab-wecom-bot >/dev/null 2>&1
systemctl restart grab-wecom-bot
sleep 1
systemctl is-active grab-wecom-bot

# ---------- nginx: 主站 orangechai.fun 增加 /grab-service/ -> 127.0.0.1:3101 ----------
MAIN_CONF=/etc/nginx/conf.d/01-main-site.conf
if grep -q "location /grab-service/" "$MAIN_CONF"; then
  echo "[install] $MAIN_CONF 已有 /grab-service/, 跳过"
else
  cp "$MAIN_CONF" "$MAIN_CONF.bak.$(date +%Y%m%d%H%M%S)"
  # 插在 ssl_ciphers 之后(该行在主站 server 块内唯一); client_max_body_size 保证 HAR 大文件上传不被 413
  sed -i '/ssl_ciphers HIGH:!aNULL:!MD5;/a\
\
    # 球场凭证助手网页服务, 反代本机 3101\
    location = /grab-service {\
        return 301 /grab-service/;\
    }\
    location /grab-service/ {\
        proxy_pass http://127.0.0.1:3101/;\
        proxy_set_header Host $host;\
        proxy_set_header X-Forwarded-Proto $scheme;\
        client_max_body_size 70m;\
    }' "$MAIN_CONF"
fi

# ---------- 清理旧版企微机器人在 api 站点的 /wecom-bot/ 反代 ----------
API_CONF=/etc/nginx/conf.d/04-api-site.conf
if grep -q "location /wecom-bot/" "$API_CONF"; then
  cp "$API_CONF" "$API_CONF.bak.$(date +%Y%m%d%H%M%S)"
  sed -i '/^    # wecom-bot:/,/^    }$/d' "$API_CONF"
  echo "[install] 已移除 $API_CONF 中的 /wecom-bot/"
fi

nginx -t
systemctl reload nginx
echo "[install] 完成. 访问地址: https://orangechai.fun/grab-service/"
