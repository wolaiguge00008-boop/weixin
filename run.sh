#!/usr/bin/env bash
# 自愈启动：node 崩溃/被 OOM 杀后 5 秒自动拉起。
# 这不是 cron、不是新闻轮询——只是进程守护。日志写到 /dev/null，不回显密钥。
cd "$(dirname "$0")"
while true; do
  node server.js
  echo "[$(date -u +%FT%TZ)] server exited code=$? — restarting in 5s" >> /dev/null
  sleep 5
done
