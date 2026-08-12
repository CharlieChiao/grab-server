#!/usr/bin/env bash
# ==============================================================================
# grab-server 快捷管理脚本 (基于 PM2)
# ------------------------------------------------------------------------------
# 用法:
#   ./restart.sh            # 重启 (若未托管则自动 pm2 start ecosystem)
#   ./restart.sh start      # 启动
#   ./restart.sh stop       # 停止 (进程保留在 pm2 列表, 状态 stopped)
#   ./restart.sh status     # 查看状态和最近日志
#   ./restart.sh logs       # 跟随日志 (Ctrl+C 退出)
#   ./restart.sh delete     # 从 pm2 列表移除 (谨慎)
#
# 说明:
#   - 服务由 PM2 托管, 开机自启已由 pm2-root.service 负责
#   - 修改代码或 ecosystem.config.cjs 后, 用 ./restart.sh 应用
#   - 应用日志: server.out.log / server.err.log (由 ecosystem.config.cjs 指定)
# ==============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="grab-court"
ECOSYSTEM="$SCRIPT_DIR/ecosystem.config.cjs"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "错误: 未找到 pm2, 请先执行: npm i -g pm2   或运行 ./deploy/install-pm2.sh" >&2
  exit 1
fi

pm2_has_app() {
  pm2 describe "$APP_NAME" >/dev/null 2>&1
}

do_start() {
  if pm2_has_app; then
    pm2 start "$APP_NAME"
  else
    pm2 start "$ECOSYSTEM"
    pm2 save >/dev/null 2>&1 || true
  fi
}

do_restart() {
  if pm2_has_app; then
    # --update-env 让新 env 变化生效
    pm2 restart "$APP_NAME" --update-env
  else
    pm2 start "$ECOSYSTEM"
    pm2 save >/dev/null 2>&1 || true
  fi
}

do_stop() {
  if pm2_has_app; then
    pm2 stop "$APP_NAME"
  else
    echo "[restart.sh] $APP_NAME 不在 pm2 列表中"
  fi
}

do_status() {
  pm2 list --no-color
  echo
  echo "--- server.out.log (tail 10) ---"
  tail -n 10 "$SCRIPT_DIR/server.out.log" 2>/dev/null || echo "(暂无)"
  echo "--- server.err.log (tail 5) ---"
  tail -n 5 "$SCRIPT_DIR/server.err.log" 2>/dev/null || echo "(暂无)"
}

do_logs() {
  pm2 logs "$APP_NAME"
}

do_delete() {
  if pm2_has_app; then
    pm2 delete "$APP_NAME"
    pm2 save >/dev/null 2>&1 || true
  else
    echo "[restart.sh] $APP_NAME 不在 pm2 列表中"
  fi
}

cmd="${1:-restart}"
case "$cmd" in
  restart) do_restart ;;
  start)   do_start ;;
  stop)    do_stop ;;
  status)  do_status ;;
  logs)    do_logs ;;
  delete)  do_delete ;;
  *) echo "用法: $0 [restart|start|stop|status|logs|delete]"; exit 2 ;;
esac
