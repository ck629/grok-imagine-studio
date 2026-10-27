#!/usr/bin/env bash
# Grok Imagine Studio 一键启动脚本
# 用法: ./start.sh   (可选环境变量: PORT=8080 XAI_API_KEY=xai-xxx ./start.sh)
set -e
cd "$(dirname "$0")"

# ---------- 定位 Node.js (>= 18) ----------
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  for cand in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "错误: 未找到 Node.js, 请安装 Node.js 18 或更高版本: https://nodejs.org"
  exit 1
fi

MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$MAJOR" -lt 18 ]; then
  echo "错误: Node.js 版本过低 (当前 v$("$NODE_BIN" -v 2>/dev/null)), 需要 >= 18"
  exit 1
fi

# ---------- 启动 ----------
PORT="${PORT:-8187}"
if [ -n "$XAI_API_KEY" ]; then
  echo "已检测到 XAI_API_KEY, 将使用服务端 Key (浏览器端无需填写)"
elif [ -f ".env" ] && grep -q '^XAI_API_KEY=..*' .env; then
  echo "已检测到 .env 中的 XAI_API_KEY, 将使用服务端 Key (浏览器端无需填写)"
else
  echo "提示: 可复制 .env.example 为 .env 并填入 XAI_API_KEY, 启动时自动加载"
fi

echo "启动 Grok Imagine Studio ..."
exec "$NODE_BIN" server.js
