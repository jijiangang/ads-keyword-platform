#!/bin/sh
set -e

# ─── 环境变量默认值 ───
PORT="${PORT:-18444}"
DB_PATH="${DB_PATH:-/app/data/ads.db}"

echo "============================================"
echo "  Ads Keyword AI Platform - Docker Entry"
echo "  Port: $PORT"
echo "  DB:   $DB_PATH"
echo "============================================"

# ─── 确保数据目录 ───
mkdir -p /app/data /app/cache

# ─── 安装依赖（首次启动时） ───
if [ ! -d /app/node_modules ]; then
  echo "[Entry] Installing dependencies..."
  cd /app && npm install --production
  echo "[Entry] Dependencies installed."
fi

# ─── 启动服务 ───
cd /app
echo "[Entry] Starting server..."
exec node src/server.cjs
