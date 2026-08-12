#!/usr/bin/env bash
# ==============================================================================
# 一键将 grab-server 纳入 PM2 托管, 并确保开机自启 (pm2-root.service)
# 用法:  sudo ./deploy/install-pm2.sh
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "错误: 未找到 pm2, 请先安装: npm i -g pm2" >&2
  exit 1
fi

cd "$PROJ_DIR"

# 依赖
if [ ! -d node_modules ]; then
  echo "[install-pm2] node_modules 不存在, 执行 npm install ..."
  npm install --omit=dev
fi

# 若已存在同名进程, 先 delete 再 start 保证参数从 ecosystem 读取
if pm2 describe grab-court >/dev/null 2>&1; then
  echo "[install-pm2] 发现已存在 grab-court, 先删除以刷新配置"
  pm2 delete grab-court || true
fi

echo "[install-pm2] 启动 grab-court ..."
pm2 start ecosystem.config.cjs

echo "[install-pm2] 固化 PM2 进程列表 (pm2 save)"
pm2 save

# 确保 pm2 systemd 启动单元存在且 enabled
if ! systemctl list-unit-files 2>/dev/null | grep -q '^pm2-root.service'; then
  echo "[install-pm2] 未检测到 pm2-root.service, 生成 systemd 启动单元 ..."
  # startup 命令返回一条 sudo env ... systemctl enable 命令; 交给 shell 执行
  pm2 startup systemd -u root --hp /root | tail -1 | bash
fi

systemctl enable pm2-root.service >/dev/null 2>&1 || true

echo
echo "===== pm2 list ====="
pm2 list --no-color || true
echo
echo "===== systemctl is-enabled pm2-root ====="
systemctl is-enabled pm2-root.service || true

echo
echo "完成. 常用命令:"
echo "  pm2 list                       # 查看进程"
echo "  pm2 restart grab-court         # 重启"
echo "  pm2 stop grab-court            # 停止"
echo "  pm2 logs grab-court            # 跟随日志"
echo "  pm2 save                       # 修改后固化, 下次开机由 pm2-root.service 恢复"
echo "  systemctl status pm2-root      # PM2 守护进程本身的 systemd 状态"
