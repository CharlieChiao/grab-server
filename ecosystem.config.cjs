/**
 * PM2 Ecosystem 配置
 * 用法:
 *   pm2 start ecosystem.config.cjs          # 启动
 *   pm2 restart grab-court                  # 重启
 *   pm2 stop grab-court                     # 停止
 *   pm2 delete grab-court                   # 移除
 *   pm2 save                                # 固化当前进程列表(下次开机由 pm2-root.service 恢复)
 *   pm2 logs grab-court                     # 跟随日志
 *
 * 注: 采用 .cjs 后缀是因为项目 package.json 里 "type": "module",
 * PM2 需要 CommonJS 语法读取该文件。
 */
module.exports = {
  apps: [
    {
      name: "grab-court",
      script: "./server.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: "10s",
      restart_delay: 2000,
      watch: false,                   // 生产不启用文件监听
      kill_timeout: 15000,            // 优雅关停等待
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      // 日志: 写回项目目录, 与 restart.sh / README 保持一致
      out_file: "./server.out.log",
      error_file: "./server.err.log",
      merge_logs: true,
      time: false,                    // 日志由应用自行控制格式
    },
  ],
};
