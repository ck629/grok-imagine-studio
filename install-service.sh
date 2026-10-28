#!/usr/bin/env bash
# Grok Imagine Studio —— systemd 开机自启安装脚本
#
# 用法:
#   ./install-service.sh              安装为「用户级」服务（默认，不需要 sudo）
#   ./install-service.sh --system     安装为「系统级」服务（需要 sudo）
#   ./install-service.sh uninstall    卸载服务
#
# 用户级服务要开机即启动（无需先登录），需要执行一次:
#   sudo loginctl enable-linger $USER
set -euo pipefail

SERVICE_NAME="grok-imagine-studio"
WORKDIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$WORKDIR/systemd/$SERVICE_NAME.service"
MODE="user"

for arg in "$@"; do
  case "$arg" in
    --system) MODE="system" ;;
    uninstall|--uninstall) MODE="uninstall" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

# ---------- 定位 Node（systemd 不读 shell PATH，必须写绝对路径）----------
detect_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  for cand in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node \
              "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    [ -x "$cand" ] && { echo "$cand"; return; }
  done
}

NODE_BIN="$(detect_node || true)"

# ---------- 卸载 ----------
if [ "$MODE" = "uninstall" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
    echo "已卸载系统级服务 $SERVICE_NAME"
  else
    systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$SERVICE_NAME.service"
    systemctl --user daemon-reload
    echo "已卸载用户级服务 $SERVICE_NAME"
  fi
  exit 0
fi

[ -n "$NODE_BIN" ] || { echo "错误: 未找到 Node.js，请先安装 Node.js 18+"; exit 1; }
[ -f "$TEMPLATE" ] || { echo "错误: 缺少模板 $TEMPLATE"; exit 1; }

# ---------- 生成 unit ----------
if [ "$MODE" = "system" ]; then
  WANTED_BY="multi-user.target"
  TARGET_DIR="/etc/systemd/system"
  SUDO="sudo"
else
  WANTED_BY="default.target"
  TARGET_DIR="$HOME/.config/systemd/user"
  SUDO=""
fi

UNIT_CONTENT="$(sed -e "s|__WORKDIR__|$WORKDIR|g" \
                    -e "s|__NODE__|$NODE_BIN|g" \
                    -e "s|__WANTED_BY__|$WANTED_BY|g" "$TEMPLATE")"

mkdir -p "$TARGET_DIR" 2>/dev/null || $SUDO mkdir -p "$TARGET_DIR"
if [ "$MODE" = "system" ]; then
  printf '%s\n' "$UNIT_CONTENT" | sudo tee "$TARGET_DIR/$SERVICE_NAME.service" >/dev/null
else
  printf '%s\n' "$UNIT_CONTENT" > "$TARGET_DIR/$SERVICE_NAME.service"
fi

# ---------- 启用并启动 ----------
# 端口占用提醒（避免旧的手动进程和 systemd 服务抢同一个端口）
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':8187 '; then
  echo "提示: 检测到 8187 端口已被占用，若为手动启动的旧进程请先结束它（kill \$(lsof -ti :8187)）"
fi

if [ "$MODE" = "system" ]; then
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
else
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
fi

sleep 1
echo ""
echo "已安装并启动：$WORKDIR"
echo "  Node:   $NODE_BIN"
echo "  服务:   $SERVICE_NAME.service ($MODE)"
echo ""
if [ "$MODE" = "system" ]; then
  echo "  状态:   sudo systemctl status $SERVICE_NAME"
  echo "  日志:   sudo journalctl -u $SERVICE_NAME -f"
  echo "  重启:   sudo systemctl restart $SERVICE_NAME"
  echo "  停止:   sudo systemctl stop $SERVICE_NAME"
else
  echo "  状态:   systemctl --user status $SERVICE_NAME"
  echo "  日志:   journalctl --user -u $SERVICE_NAME -f"
  echo "  重启:   systemctl --user restart $SERVICE_NAME"
  echo "  停止:   systemctl --user stop $SERVICE_NAME"
  echo ""
  echo "  开机自启（未登录也生效）需要再执行一次："
  echo "    sudo loginctl enable-linger $USER"
fi
echo ""
echo "访问: http://127.0.0.1:8187   （端口/Key/代理请在 .env 中配置后 systemctl restart）"
