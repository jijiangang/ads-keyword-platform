#!/bin/bash
# 广告关键词管理平台 - 代码生成脚本
# 一次性生成所有未完成的大文件
set -e
cd "$(dirname "$0")"

echo "=== 1/3 生成 analysis-engine.cjs ==="
node build-analysis-engine.cjs
echo "   OK ($(wc -l < src/analysis-engine.cjs) lines)"

echo "=== 2/3 生成 server.cjs 后半部分(API路由) ==="
node build-server-routes.cjs
echo "   OK ($(wc -l < src/server.cjs) lines)"

echo "=== 3/3 生成前端 index.html ==="
node build-frontend.cjs
echo "   OK ($(wc -l < src/public/index.html) lines)"

echo ""
echo "=== 语法检查 ==="
node -c src/server.cjs && echo " server.cjs ✅"
node -c src/analysis-engine.cjs && echo " analysis-engine.cjs ✅"
echo " index.html (纯前端，无需检查)"

echo ""
echo "=== 完成 ==="
echo "总行数:"
wc -l src/server.cjs src/analysis-engine.cjs src/public/index.html
